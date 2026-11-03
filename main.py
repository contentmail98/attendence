"""
Multi-Tenant Biometric Attendance Server
Features:
1. Super Admin Panel: /super-admin (Manage coaching institutes, codes, subscriptions)
2. Institute Admin Portal: /portal/{institute_code} (Each center has its isolated student directory & punch logs)
3. Institute Biometric Webhook: /api/institutes/{institute_code}/events (Point Hikvision terminal directly to this URL)
4. Mobile App REST APIs for Parents (Scoped by Institute Code + Parent Phone Number)
"""

import json
import logging
import os
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional
from fastapi import FastAPI, Request, Response, Depends, HTTPException, status
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import func
import uvicorn
from dotenv import load_dotenv

load_dotenv()

from database import init_db, get_db, Institute, Student, AttendanceRecord
from notifier import send_expo_push_notification

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("hikvision_events.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger("MultiTenantServer")

# Initialize database tables
init_db()

app = FastAPI(
    title="Multi-Tenant Biometric Attendance Platform",
    description="Multi-Coaching Center Biometric Attendance Gateway & Parent Mobile Notification System",
    version="3.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEBOUNCE_MINUTES = float(os.getenv("DEBOUNCE_MINUTES", "5.0"))


# ---------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------
class InstituteCreate(BaseModel):
    code: str
    name: str
    contact_person: Optional[str] = None
    contact_phone: Optional[str] = None
    address: Optional[str] = None


class StudentCreate(BaseModel):
    student_id: str
    name: str
    grade: Optional[str] = None
    parent_name: Optional[str] = None
    parent_phone: str


class ParentTokenRegister(BaseModel):
    institute_code: str
    parent_phone: str
    expo_push_token: str


# ---------------------------------------------------------
# Seed Default Institutes on First Launch
# ---------------------------------------------------------
def seed_default_institutes():
    db = next(get_db())
    if db.query(Institute).count() == 0:
        apex = Institute(
            code="apex",
            name="Apex Coaching Academy",
            contact_person="Director Sharma",
            contact_phone="9876543210",
            address="Plot 42, Knowledge Park, Delhi NCR",
        )
        allen = Institute(
            code="allen",
            name="Allen Career Institute",
            contact_person="Center Head Verma",
            contact_phone="9123456789",
            address="Road 1, Coaching Hub, Kota",
        )
        db.add_all([apex, allen])
        db.commit()

        # Seed sample student for Apex
        s1 = Student(
            institute_id=apex.id,
            student_id="101",
            name="Rohan Sharma",
            grade="Class 10 - Batch A",
            parent_name="Suresh Sharma",
            parent_phone="9876543210",
        )
        # Seed sample student for Allen
        s2 = Student(
            institute_id=allen.id,
            student_id="101",  # Same ID allowed in different institute!
            name="Priya Patel",
            grade="Class 12 - Science",
            parent_name="Vikram Patel",
            parent_phone="9123456789",
        )
        db.add_all([s1, s2])
        db.commit()
        logger.info("Initialized default institutes: Apex and Allen")


seed_default_institutes()


# ---------------------------------------------------------
# HTML Portal Endpoints
# ---------------------------------------------------------
@app.get("/super-admin", response_class=HTMLResponse)
@app.get("/", response_class=HTMLResponse)
async def super_admin_page():
    path = os.path.join(os.path.dirname(__file__), "templates", "super_admin.html")
    with open(path, "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.get("/parent", response_class=HTMLResponse)
@app.get("/parent-app", response_class=HTMLResponse)
@app.get("/app", response_class=HTMLResponse)
async def parent_web_app():
    """Serves the Parent Web App (accessible on any smartphone/desktop browser)."""
    path = os.path.join(os.path.dirname(__file__), "templates", "parent_app.html")
    with open(path, "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.get("/portal/{institute_code}", response_class=HTMLResponse)
async def institute_portal_page(institute_code: str, db: Session = Depends(get_db)):
    inst = db.query(Institute).filter(Institute.code == institute_code.lower()).first()
    if not inst:
        raise HTTPException(status_code=404, detail=f"Institute '{institute_code}' not found")
    path = os.path.join(os.path.dirname(__file__), "templates", "institute_portal.html")
    with open(path, "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())


# ---------------------------------------------------------
# Backward Compatibility Routes for Single Institute Setup
# ---------------------------------------------------------
@app.get("/admin", response_class=HTMLResponse)
async def admin_portal_redirect():
    """Redirects legacy /admin to the primary institute portal (apex)."""
    path = os.path.join(os.path.dirname(__file__), "templates", "institute_portal.html")
    with open(path, "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.get("/api/admin/recent-punches")
def legacy_recent_punches(limit: int = 15, db: Session = Depends(get_db)):
    """Fallback legacy endpoint for punches from the default institute."""
    records = (
        db.query(AttendanceRecord)
        .order_by(AttendanceRecord.punch_time.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": r.id,
            "student_id": r.student_id,
            "student_name": f"Student #{r.student_id}",
            "punch_time": r.punch_time.isoformat(),
            "punch_type": r.punch_type,
            "device_name": r.device_name,
        }
        for r in records
    ]


@app.get("/api/admin/students")
def legacy_all_students(db: Session = Depends(get_db)):
    students = db.query(Student).all()
    return [
        {
            "id": s.id,
            "student_id": s.student_id,
            "name": s.name,
            "grade": s.grade,
            "parent_name": s.parent_name,
            "parent_phone": s.parent_phone,
            "parent_fcm_token": s.parent_fcm_token,
        }
        for s in students
    ]


# ---------------------------------------------------------
# Super Admin APIs
# ---------------------------------------------------------
@app.get("/api/super-admin/institutes")
def list_institutes(db: Session = Depends(get_db)):
    institutes = db.query(Institute).all()
    results = []
    for inst in institutes:
        student_count = db.query(Student).filter(Student.institute_id == inst.id).count()
        results.append({
            "id": inst.id,
            "code": inst.code,
            "name": inst.name,
            "contact_person": inst.contact_person,
            "contact_phone": inst.contact_phone,
            "address": inst.address,
            "student_count": student_count,
            "is_active": inst.is_active,
        })
    return results


@app.post("/api/super-admin/institutes")
def create_institute(data: InstituteCreate, db: Session = Depends(get_db)):
    code = data.code.lower().strip()
    existing = db.query(Institute).filter(Institute.code == code).first()
    if existing:
        raise HTTPException(status_code=400, detail="Institute code already exists")

    inst = Institute(
        code=code,
        name=data.name.strip(),
        contact_person=data.contact_person,
        contact_phone=data.contact_phone,
        address=data.address,
    )
    db.add(inst)
    db.commit()
    db.refresh(inst)
    return {"status": "ok", "institute_id": inst.id, "code": inst.code}


@app.delete("/api/super-admin/institutes/{institute_code}")
def delete_institute(institute_code: str, db: Session = Depends(get_db)):
    code = institute_code.lower().strip()
    inst = db.query(Institute).filter(Institute.code == code).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Institute not found")

    # Cascade delete all attendance records and students under this institute
    db.query(AttendanceRecord).filter(AttendanceRecord.institute_id == inst.id).delete()
    db.query(Student).filter(Student.institute_id == inst.id).delete()
    db.delete(inst)
    db.commit()
    return {"status": "ok", "message": f"Institute {code} and all associated records deleted."}


@app.get("/api/super-admin/stats")
def get_super_admin_stats(db: Session = Depends(get_db)):
    now = datetime.now()
    start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return {
        "total_institutes": db.query(Institute).count(),
        "total_students": db.query(Student).count(),
        "total_parents": db.query(func.count(func.distinct(Student.parent_phone))).scalar() or 0,
        "today_punches": db.query(AttendanceRecord).filter(AttendanceRecord.punch_time >= start_of_day).count(),
    }


# ---------------------------------------------------------
# Multi-Tenant Biometric Webhook Receiver
# ---------------------------------------------------------
@app.post("/api/institutes/{institute_code}/events")
@app.post("/api/events")  # Fallback: defaults to first institute if called directly
async def receive_biometric_event(
    request: Request,
    institute_code: str = "apex",
    db: Session = Depends(get_db)
):
    """
    Receives HTTP POST events pushed by a Hikvision Terminal configured for this specific institute.
    """
    inst = db.query(Institute).filter(Institute.code == institute_code.lower()).first()
    if not inst:
        return Response(content='{"status":"error","message":"Unknown institute"}', status_code=404)

    content_type = request.headers.get("content-type", "")

    try:
        raw_json_str = None
        if "multipart/form-data" in content_type:
            form = await request.form()
            for key, value in form.items():
                if key in ("event_log", "AccessControllerEvent", "info"):
                    raw_json_str = value
                elif isinstance(value, str) and (value.startswith("{") or "AccessControllerEvent" in value):
                    raw_json_str = value
            payload = json.loads(raw_json_str) if raw_json_str else {k: str(v) for k, v in form.items()}
        elif "application/json" in content_type:
            payload = await request.json()
        else:
            body = await request.body()
            payload = json.loads(body.decode("utf-8", errors="ignore"))

        ace = payload.get("AccessControllerEvent", payload)
        employee_no = (
            ace.get("employeeNoString")
            or ace.get("employeeNo")
            or payload.get("employeeNoString")
            or payload.get("employeeNo")
        )
        device_name = payload.get("deviceName") or ace.get("deviceName") or "Hikvision Terminal"

        if not employee_no:
            return {"status": "success", "message": "Ignored non-punch event"}

        student_id = str(employee_no)
        logger.info(
            "Biometric punch at [%s] for Student ID: %s",
            inst.name,
            student_id,
        )

        now = datetime.now()
        start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)

        # Smart Toggle & Debounce within this specific institute
        last_record = (
            db.query(AttendanceRecord)
            .filter(
                AttendanceRecord.institute_id == inst.id,
                AttendanceRecord.student_id == student_id,
                AttendanceRecord.punch_time >= start_of_day,
            )
            .order_by(AttendanceRecord.punch_time.desc())
            .first()
        )

        if last_record:
            diff_seconds = (now - last_record.punch_time).total_seconds()
            if diff_seconds < (DEBOUNCE_MINUTES * 60):
                logger.warning("Debounce ignored duplicate punch for student %s in %s", student_id, inst.name)
                return {"status": "success", "processed": false, "punch_type": "DEBOUNCED"}

            punch_type = "EXIT" if last_record.punch_type == "ENTRY" else "ENTRY"
        else:
            punch_type = "ENTRY"

        # Save to database
        record = AttendanceRecord(
            institute_id=inst.id,
            student_id=student_id,
            punch_time=now,
            punch_type=punch_type,
            device_name=device_name,
        )
        db.add(record)
        db.commit()

        # Send push notification to parents registered under this institute
        student = (
            db.query(Student)
            .filter(Student.institute_id == inst.id, Student.student_id == student_id)
            .first()
        )
        student_name = student.name if student else f"Student #{student_id}"

        if punch_type == "ENTRY":
            title = f"🏫 Check-In • {inst.name}"
            body = f"{student_name} entered the center at {now.strftime('%I:%M %p')}."
        else:
            title = f"👋 Check-Out • {inst.name}"
            body = f"{student_name} has left the center at {now.strftime('%I:%M %p')}."

        if student and student.parent_fcm_token:
            send_expo_push_notification(
                token=student.parent_fcm_token,
                title=title,
                body=body,
                data={
                    "student_id": student_id,
                    "institute_code": inst.code,
                    "punch_type": punch_type,
                },
            )

        return {
            "status": "success",
            "institute": inst.code,
            "processed": True,
            "punch_type": punch_type,
        }

    except Exception as e:
        logger.error("Error processing biometric event: %s", str(e), exc_info=True)
        return Response(
            content=json.dumps({"status": "error", "message": str(e)}),
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            media_type="application/json",
        )


# ---------------------------------------------------------
# Institute Specific Management APIs
# ---------------------------------------------------------
@app.get("/api/institutes/{institute_code}/meta")
def get_institute_meta(institute_code: str, db: Session = Depends(get_db)):
    inst = db.query(Institute).filter(Institute.code == institute_code.lower()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Institute not found")
    return {
        "id": inst.id,
        "code": inst.code,
        "name": inst.name,
        "address": inst.address,
        "contact_phone": inst.contact_phone,
    }


@app.get("/api/institutes/{institute_code}/students")
def get_institute_students(institute_code: str, db: Session = Depends(get_db)):
    inst = db.query(Institute).filter(Institute.code == institute_code.lower()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Institute not found")

    students = db.query(Student).filter(Student.institute_id == inst.id).order_by(Student.id.desc()).all()
    return [
        {
            "id": s.id,
            "student_id": s.student_id,
            "name": s.name,
            "grade": s.grade,
            "parent_name": s.parent_name,
            "parent_phone": s.parent_phone,
            "parent_fcm_token": s.parent_fcm_token,
        }
        for s in students
    ]


@app.post("/api/institutes/{institute_code}/students")
def create_institute_student(
    institute_code: str,
    data: StudentCreate,
    db: Session = Depends(get_db)
):
    inst = db.query(Institute).filter(Institute.code == institute_code.lower()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Institute not found")

    student = (
        db.query(Student)
        .filter(Student.institute_id == inst.id, Student.student_id == data.student_id)
        .first()
    )

    if not student:
        student = Student(
            institute_id=inst.id,
            student_id=data.student_id,
            name=data.name,
            grade=data.grade,
            parent_name=data.parent_name,
            parent_phone=data.parent_phone,
        )
        db.add(student)
    else:
        student.name = data.name
        student.grade = data.grade
        student.parent_name = data.parent_name
        student.parent_phone = data.parent_phone

    db.commit()
    return {"status": "ok", "student_id": student.student_id}


@app.delete("/api/institutes/{institute_code}/students/{student_id}")
def delete_institute_student(
    institute_code: str,
    student_id: str,
    db: Session = Depends(get_db)
):
    inst = db.query(Institute).filter(Institute.code == institute_code.lower()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Institute not found")

    student = (
        db.query(Student)
        .filter(Student.institute_id == inst.id, Student.student_id == student_id)
        .first()
    )
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")

    db.query(AttendanceRecord).filter(
        AttendanceRecord.institute_id == inst.id,
        AttendanceRecord.student_id == student_id,
    ).delete()
    db.delete(student)
    db.commit()
    return {"status": "ok"}


@app.get("/api/institutes/{institute_code}/recent-punches")
def get_institute_recent_punches(
    institute_code: str,
    db: Session = Depends(get_db)
):
    clean_code = institute_code.lower().strip()
    inst = db.query(Institute).filter(Institute.code == clean_code).first()
    
    # If the requested code is "admin", gracefully fall back to the first available institute
    if not inst and clean_code == "admin":
        inst = db.query(Institute).first()

    if not inst:
        return []

    records = (
        db.query(AttendanceRecord, Student.name)
        .outerjoin(
            Student,
            (AttendanceRecord.student_id == Student.student_id)
            & (AttendanceRecord.institute_id == Student.institute_id),
        )
        .filter(AttendanceRecord.institute_id == inst.id)
        .order_by(AttendanceRecord.punch_time.desc())
        .limit(20)
        .all()
    )

    return [
        {
            "id": r[0].id,
            "student_id": r[0].student_id,
            "student_name": r[1] or f"Student #{r[0].student_id}",
            "punch_time": r[0].punch_time.isoformat(),
            "punch_type": r[0].punch_type,
            "device_name": r[0].device_name,
        }
        for r in records
    ]


# ---------------------------------------------------------
# Mobile App REST APIs (Multi-Tenant Scoped)
# ---------------------------------------------------------
@app.get("/api/institutes/{institute_code}/parents/{parent_phone}/students")
@app.get("/api/parents/{parent_phone}/students")  # Backward-compatible fallback
def get_parent_students_by_institute(
    parent_phone: str,
    institute_code: Optional[str] = None,
    db: Session = Depends(get_db)
):
    clean_phone = parent_phone.strip()
    
    if institute_code:
        inst = db.query(Institute).filter(Institute.code == institute_code.lower().strip()).first()
        if not inst:
            raise HTTPException(status_code=404, detail="Invalid Institute Code")
        students = (
            db.query(Student)
            .filter(Student.institute_id == inst.id, Student.parent_phone == clean_phone)
            .all()
        )
    else:
        # Fallback to search all or default institute
        students = db.query(Student).filter(Student.parent_phone == clean_phone).all()
        inst = db.query(Institute).first()

    return [
        {
            "student_id": s.student_id,
            "name": s.name,
            "grade": s.grade,
            "institute_name": inst.name if inst else "Coaching Center",
            "institute_code": inst.code if inst else "apex",
        }
        for s in students
    ]


@app.post("/api/parents/register-token")
def register_parent_token(req: ParentTokenRegister, db: Session = Depends(get_db)):
    inst = db.query(Institute).filter(Institute.code == req.institute_code.lower()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Invalid Institute Code")

    students = (
        db.query(Student)
        .filter(Student.institute_id == inst.id, Student.parent_phone == req.parent_phone)
        .all()
    )
    for s in students:
        s.parent_fcm_token = req.expo_push_token
    db.commit()
    return {"status": "ok", "updated": len(students)}


@app.get("/api/institutes/{institute_code}/students/{student_id}/attendance")
def get_student_attendance_history(
    institute_code: str,
    student_id: str,
    db: Session = Depends(get_db)
):
    inst = db.query(Institute).filter(Institute.code == institute_code.lower()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Invalid Institute Code")

    logs = (
        db.query(AttendanceRecord)
        .filter(AttendanceRecord.institute_id == inst.id, AttendanceRecord.student_id == student_id)
        .order_by(AttendanceRecord.punch_time.desc())
        .limit(100)
        .all()
    )
    return [
        {
            "id": log.id,
            "student_id": log.student_id,
            "punch_time": log.punch_time.isoformat() if log.punch_time else None,
            "punch_type": log.punch_type,
            "device_name": log.device_name,
        }
        for log in logs
    ]


@app.get("/health")
def health():
    return {"status": "online", "mode": "multi-tenant", "time": datetime.now().isoformat()}


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
