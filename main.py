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
from fastapi.responses import HTMLResponse, PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import func
import uvicorn
from dotenv import load_dotenv

load_dotenv()

from database import (
    init_db,
    get_db,
    SessionLocal,
    Institute,
    Student,
    AttendanceRecord,
    Teacher,
    Announcement,
    TimetableSlot,
    Test,
    TestScore,
    IST,
    get_ist_now,
)
from notifier import send_expo_push_notification, send_expo_push_batch

def format_punch_time(dt: Optional[datetime]) -> Optional[str]:
    """Formats datetime as ISO-8601 string with Indian Standard Time (+05:30) offset."""
    if not dt:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=IST).isoformat()
    return dt.astimezone(IST).isoformat()

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

DEBOUNCE_MINUTES = float(os.getenv("DEBOUNCE_MINUTES", "5.0"))  # 5 minutes debounce duration for rapid/duplicate punches


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


class LoginRequest(BaseModel):
    phone: str


class EarlyExitRequest(BaseModel):
    student_id: str
    reason: str
    notes: Optional[str] = None
    device_name: Optional[str] = "Teacher Portal"


class AnnouncementCreate(BaseModel):
    title: str
    category: str  # 'HOLIDAY', 'CLASS_CHANGE', 'EXAM', 'GENERAL'
    description: str
    effective_date: Optional[str] = None
    batch_grade: Optional[str] = "All"
    created_by: Optional[str] = None


class TimetableSlotCreate(BaseModel):
    day: str  # 'Monday', 'Tuesday', etc.
    subject: str
    time_slot: str  # e.g. "04:00 PM - 05:30 PM"
    teacher: Optional[str] = None
    room: Optional[str] = None
    grade: Optional[str] = "All"


class TestCreate(BaseModel):
    name: str
    subject: str
    test_date: Optional[str] = None
    max_marks: int = 100
    grade: Optional[str] = "All"


class SingleScoreEntry(BaseModel):
    student_id: str
    marks_obtained: int
    remarks: Optional[str] = None


class TestScoresSubmit(BaseModel):
    scores: List[SingleScoreEntry]


class TeacherCreate(BaseModel):
    name: str
    phone: str
    subject: Optional[str] = None


# ---------------------------------------------------------
# Seed Default Institutes & Demo Data on First Launch
# ---------------------------------------------------------
def seed_default_institutes():
    db = SessionLocal()
    try:
        # 1. Base institutes
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
                student_id="101",
                name="Priya Patel",
                grade="Class 12 - Science",
                parent_name="Vikram Patel",
                parent_phone="9123456789",
            )
            db.add_all([s1, s2])
            db.commit()
            logger.info("Initialized default institutes: Apex and Allen")

        # 2. Seed data for all institutes that don't have teachers/timetable/tests yet
        institutes = db.query(Institute).all()
        for inst in institutes:
            # Seed Teacher if none exist
            if db.query(Teacher).filter(Teacher.institute_id == inst.id).count() == 0:
                teacher_phone = inst.contact_phone or "9832041529"
                teacher_name = inst.contact_person or "Arup Sir"
                t1 = Teacher(
                    institute_id=inst.id,
                    name=teacher_name,
                    phone=teacher_phone,
                    subject="Physics & Chemistry",
                )
                db.add(t1)
                db.commit()

            # Ensure Arup Sir (9832041529) is always present for prepx
            if inst.code.lower() == "prepx":
                arup = db.query(Teacher).filter(Teacher.institute_id == inst.id, Teacher.phone == "9832041529").first()
                if not arup:
                    db.add(Teacher(
                        institute_id=inst.id,
                        name="Arup Sir",
                        phone="9832041529",
                        subject="Physics & Chemistry",
                    ))
                    db.commit()

            # Seed Announcements if none exist
            if db.query(Announcement).filter(Announcement.institute_id == inst.id).count() == 0:
                a1 = Announcement(
                    institute_id=inst.id,
                    title="Guru Nanak Jayanti Holiday",
                    category="HOLIDAY",
                    description="Coaching center will remain closed this Friday. All regular batches resume Saturday morning.",
                    effective_date="Friday, Nov 28",
                    batch_grade="All",
                    created_by="Admin Office",
                )
                a2 = Announcement(
                    institute_id=inst.id,
                    title="Chemistry Doubt Session Rescheduled",
                    category="CLASS_CHANGE",
                    description="Wednesday Chemistry doubt clearing class moved to 05:00 PM - 06:30 PM in Room 1.",
                    effective_date="Wednesday 05:00 PM",
                    batch_grade="Class 12",
                    created_by="Arup Sir",
                )
                a3 = Announcement(
                    institute_id=inst.id,
                    title="Upcoming All-India Mock Test 3",
                    category="EXAM",
                    description="Comprehensive syllabus revision test scheduled for coming Sunday at 10:00 AM.",
                    effective_date="Sunday 10:00 AM",
                    batch_grade="All",
                    created_by="Academic Head",
                )
                db.add_all([a1, a2, a3])
                db.commit()

            # Seed Weekly Timetable if none exist
            if db.query(TimetableSlot).filter(TimetableSlot.institute_id == inst.id).count() == 0:
                slots = [
                    TimetableSlot(institute_id=inst.id, day="Monday", subject="Chemistry - Physical", time_slot="04:00 PM - 05:15 PM", teacher="Arup Sir", room="Room 1", grade="All"),
                    TimetableSlot(institute_id=inst.id, day="Monday", subject="Mathematics - Calculus", time_slot="05:30 PM - 06:45 PM", teacher="Prof. Roy", room="Room 2", grade="All"),
                    TimetableSlot(institute_id=inst.id, day="Tuesday", subject="Physics - Mechanics", time_slot="04:00 PM - 05:15 PM", teacher="Dr. Verma", room="Room 1", grade="All"),
                    TimetableSlot(institute_id=inst.id, day="Tuesday", subject="Biology / Logic", time_slot="05:30 PM - 06:45 PM", teacher="Ms. Sen", room="Room 3", grade="All"),
                    TimetableSlot(institute_id=inst.id, day="Wednesday", subject="Chemistry - Lab & Problem Solving", time_slot="04:00 PM - 05:30 PM", teacher="Arup Sir", room="Room 1", grade="All"),
                    TimetableSlot(institute_id=inst.id, day="Thursday", subject="Mathematics - Algebra", time_slot="04:00 PM - 05:15 PM", teacher="Prof. Roy", room="Room 2", grade="All"),
                    TimetableSlot(institute_id=inst.id, day="Thursday", subject="Physics - Electrodynamics", time_slot="05:30 PM - 06:45 PM", teacher="Dr. Verma", room="Room 1", grade="All"),
                    TimetableSlot(institute_id=inst.id, day="Friday", subject="Revision & Doubt Clearing", time_slot="04:30 PM - 06:00 PM", teacher="All Faculty", room="Main Hall", grade="All"),
                    TimetableSlot(institute_id=inst.id, day="Saturday", subject="Weekly Test Series", time_slot="10:00 AM - 12:00 PM", teacher="Exam Incharge", room="Hall A", grade="All"),
                    TimetableSlot(institute_id=inst.id, day="Sunday", subject="Test Discussion & Mentorship", time_slot="10:00 AM - 11:30 AM", teacher="Arup Sir", room="Room 1", grade="All"),
                ]
                db.add_all(slots)
                db.commit()

            # Seed Tests and Cumulative Scores if none exist
            if db.query(Test).filter(Test.institute_id == inst.id).count() == 0:
                now = get_ist_now()
                test1 = Test(
                    institute_id=inst.id,
                    name="Test 1 - Fundamental Concepts",
                    subject="Science & Chemistry",
                    test_date=now - timedelta(days=14),
                    max_marks=100,
                    grade="All",
                )
                test2 = Test(
                    institute_id=inst.id,
                    name="Test 2 - Chemical Bonding & Structure",
                    subject="Science & Chemistry",
                    test_date=now - timedelta(days=7),
                    max_marks=100,
                    grade="All",
                )
                test3 = Test(
                    institute_id=inst.id,
                    name="Test 3 - Full Periodic Table & Kinetics",
                    subject="Science & Chemistry",
                    test_date=now - timedelta(days=1),
                    max_marks=100,
                    grade="All",
                )
                db.add_all([test1, test2, test3])
                db.commit()

                # Add sample cumulative scores for existing students in this institute
                inst_students = db.query(Student).filter(Student.institute_id == inst.id).all()
                for student in inst_students:
                    sc1 = TestScore(
                        test_id=test1.id,
                        student_id=student.student_id,
                        marks_obtained=72,
                        percentage=72,
                        remarks="Good foundation. Practice stoichiometry numericals.",
                    )
                    sc2 = TestScore(
                        test_id=test2.id,
                        student_id=student.student_id,
                        marks_obtained=80,
                        percentage=80,
                        remarks="Solid improvement (+8%) in molecular orbital questions.",
                    )
                    sc3 = TestScore(
                        test_id=test3.id,
                        student_id=student.student_id,
                        marks_obtained=88,
                        percentage=88,
                        remarks="Excellent progress (+8%)! Consistent hard work paying off.",
                    )
                    db.add_all([sc1, sc2, sc3])
                db.commit()

    except Exception as e:
        logger.warning("Default institutes seeding skipped: %s", str(e))
        db.rollback()
    finally:
        db.close()
        from database import engine
        engine.dispose()


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


@app.get("/privacy-policy", response_class=HTMLResponse)
@app.get("/privacy", response_class=HTMLResponse)
async def privacy_policy_page():
    """Serves the Privacy Policy Page."""
    path = os.path.join(os.path.dirname(__file__), "templates", "privacy_policy.html")
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
            "punch_time": format_punch_time(r.punch_time),
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
            "integration_date": inst.integration_date.strftime("%Y-%m-%d") if inst.integration_date else None,
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
    now = get_ist_now()
    start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return {
        "total_institutes": db.query(Institute).count(),
        "total_students": db.query(Student).count(),
        "total_parents": db.query(func.count(func.distinct(Student.parent_phone))).scalar() or 0,
        "today_punches": db.query(AttendanceRecord).filter(AttendanceRecord.punch_time >= start_of_day).count(),
    }


@app.put("/api/super-admin/institutes/{institute_code}/integration-date")
def set_integration_date(institute_code: str, request_body: dict, db: Session = Depends(get_db)):
    """Set the integration date for an institute. Only attendance records on or after this date will be shown."""
    inst = db.query(Institute).filter(Institute.code == institute_code.lower().strip()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Institute not found")

    date_str = request_body.get("integration_date")
    if not date_str:
        inst.integration_date = None
        db.commit()
        return {"status": "ok", "message": f"Integration date cleared for {inst.code}"}

    try:
        inst.integration_date = datetime.strptime(date_str, "%Y-%m-%d")
        db.commit()
        return {"status": "ok", "institute": inst.code, "integration_date": date_str}
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD.")


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

        # Parse Hikvision terminal timestamp or default to Indian Standard Time (IST)
        raw_event_time = ace.get("dateTime") or payload.get("dateTime")
        punch_dt = None
        if raw_event_time:
            try:
                clean_time = str(raw_event_time).replace("Z", "+00:00")
                parsed = datetime.fromisoformat(clean_time)
                if parsed.tzinfo is not None:
                    parsed = parsed.astimezone(IST)
                punch_dt = parsed.replace(tzinfo=None)
            except Exception:
                punch_dt = None

        now = punch_dt if punch_dt else get_ist_now()
        server_received_at = get_ist_now()

        # Log timing to diagnose delays: device timestamp vs server receive time
        logger.info(
            "⏱ PUNCH RECEIVED | Institute: [%s] | Student: %s | Device Time: %s | Server Time: %s | Delay: %s seconds",
            inst.name,
            student_id,
            now.strftime('%Y-%m-%d %I:%M:%S %p') if punch_dt else "NOT PROVIDED",
            server_received_at.strftime('%Y-%m-%d %I:%M:%S %p'),
            f"{(server_received_at - now).total_seconds():.0f}" if punch_dt else "N/A",
        )

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
                return {"status": "success", "processed": False, "punch_type": "DEBOUNCED"}

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
            logger.info("📲 Sending push notification to %s (token: %s...)", student.name, student.parent_fcm_token[:30])
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
        else:
            logger.warning("⚠ NO PUSH TOKEN for student %s (ID: %s) — notification NOT sent!", student_name, student_id)

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
            "punch_time": format_punch_time(r[0].punch_time),
            "punch_type": r[0].punch_type,
            "device_name": r[0].device_name,
            "reason": r[0].reason,
            "is_early_exit": bool(r[0].is_early_exit),
            "notes": r[0].notes,
        }
        for r in records
    ]


# ---------------------------------------------------------
# Mobile App REST APIs (Multi-Tenant Scoped)
# ---------------------------------------------------------
@app.post("/api/institutes/{institute_code}/auth/login")
def institute_unified_login(
    institute_code: str,
    req: LoginRequest,
    db: Session = Depends(get_db)
):
    """
    Unified Login for Teachers and Parents using the same login page.
    Checks if phone belongs to a Teacher, a Student's Parent, or both.
    """
    clean_code = institute_code.lower().strip()
    clean_phone = req.phone.strip()

    inst = db.query(Institute).filter(Institute.code == clean_code).first()
    if not inst:
        raise HTTPException(status_code=404, detail=f"Institute code '{clean_code.upper()}' not found.")

    teachers = (
        db.query(Teacher)
        .filter(Teacher.institute_id == inst.id, Teacher.phone == clean_phone, Teacher.is_active == True)
        .all()
    )

    students = (
        db.query(Student)
        .filter(Student.institute_id == inst.id, Student.parent_phone == clean_phone)
        .all()
    )

    roles = []
    if teachers:
        roles.append("teacher")
    if students:
        roles.append("parent")

    if not roles:
        raise HTTPException(
            status_code=404,
            detail=f"Mobile number '{clean_phone}' is not registered as a Teacher or Parent under {inst.name}."
        )

    teacher_data = None
    if teachers:
        t = teachers[0]
        teacher_data = {
            "id": t.id,
            "name": t.name,
            "phone": t.phone,
            "subject": t.subject,
        }

    student_list = [
        {
            "student_id": s.student_id,
            "name": s.name,
            "grade": s.grade,
            "parent_name": s.parent_name,
            "parent_phone": s.parent_phone,
            "institute_name": inst.name,
            "institute_code": inst.code,
        }
        for s in students
    ]

    return {
        "status": "ok",
        "institute": {
            "id": inst.id,
            "code": inst.code,
            "name": inst.name,
            "contact_phone": inst.contact_phone,
            "address": inst.address,
        },
        "roles": roles,
        "primary_role": roles[0],
        "teacher": teacher_data,
        "students": student_list,
    }


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
    since: Optional[str] = None,
    db: Session = Depends(get_db)
):
    inst = db.query(Institute).filter(Institute.code == institute_code.lower()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Invalid Institute Code")

    query = (
        db.query(AttendanceRecord)
        .filter(AttendanceRecord.institute_id == inst.id, AttendanceRecord.student_id == student_id)
    )

    # Filter records from a specific date onwards (e.g. ?since=2026-11-06)
    cutoff = None
    if since:
        try:
            cutoff = datetime.strptime(since, "%Y-%m-%d")
        except ValueError:
            pass
    if not cutoff and inst.integration_date:
        cutoff = inst.integration_date

    if cutoff:
        query = query.filter(AttendanceRecord.punch_time >= cutoff)

    logs = (
        query
        .order_by(AttendanceRecord.punch_time.desc())
        .limit(100)
        .all()
    )
    return [
        {
            "id": log.id,
            "student_id": log.student_id,
            "punch_time": format_punch_time(log.punch_time),
            "punch_type": log.punch_type,
            "device_name": log.device_name,
            "reason": log.reason,
            "is_early_exit": bool(log.is_early_exit),
            "notes": log.notes,
        }
        for log in logs
    ]


# ---------------------------------------------------------
# Feature 1: Early Exit Logging & Notification
# ---------------------------------------------------------
@app.post("/api/institutes/{institute_code}/early-exit")
def record_early_exit(
    institute_code: str,
    req: EarlyExitRequest,
    db: Session = Depends(get_db)
):
    inst = db.query(Institute).filter(Institute.code == institute_code.lower().strip()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Institute not found")

    student = (
        db.query(Student)
        .filter(Student.institute_id == inst.id, Student.student_id == req.student_id)
        .first()
    )
    if not student:
        raise HTTPException(status_code=404, detail=f"Student #{req.student_id} not found")

    now = get_ist_now()
    record = AttendanceRecord(
        institute_id=inst.id,
        student_id=req.student_id,
        punch_time=now,
        punch_type="EXIT",
        device_name=req.device_name or "Teacher Portal",
        notes=req.notes,
        reason=req.reason,
        is_early_exit=True,
    )
    db.add(record)
    db.commit()
    db.refresh(record)

    # Send immediate notification to student's parent
    title = f"🚨 Early Departure Alert • {inst.name}"
    body = f"{student.name} departed early at {now.strftime('%I:%M %p')}. Reason: {req.reason}."

    if student.parent_fcm_token:
        send_expo_push_notification(
            token=student.parent_fcm_token,
            title=title,
            body=body,
            data={
                "type": "EARLY_EXIT",
                "student_id": student.student_id,
                "institute_code": inst.code,
                "reason": req.reason,
                "punch_type": "EXIT",
            },
        )
        logger.info("Early departure push sent to parent of %s (token: %s...)", student.name, student.parent_fcm_token[:25])

    return {
        "status": "ok",
        "message": f"Early exit recorded for {student.name}",
        "record_id": record.id,
        "punch_time": format_punch_time(record.punch_time),
        "reason": record.reason,
    }


# ---------------------------------------------------------
# Feature 2: Declaration of Holiday or Class Change
# ---------------------------------------------------------
@app.get("/api/institutes/{institute_code}/announcements")
def list_announcements(
    institute_code: str,
    db: Session = Depends(get_db)
):
    inst = db.query(Institute).filter(Institute.code == institute_code.lower().strip()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Institute not found")

    announcements = (
        db.query(Announcement)
        .filter(Announcement.institute_id == inst.id)
        .order_by(Announcement.created_at.desc(), Announcement.id.desc())
        .limit(50)
        .all()
    )

    return [
        {
            "id": a.id,
            "title": a.title,
            "category": a.category,
            "description": a.description,
            "effective_date": a.effective_date,
            "batch_grade": a.batch_grade,
            "created_by": a.created_by,
            "created_at": format_punch_time(a.created_at),
        }
        for a in announcements
    ]


@app.post("/api/institutes/{institute_code}/announcements")
def create_announcement(
    institute_code: str,
    req: AnnouncementCreate,
    db: Session = Depends(get_db)
):
    inst = db.query(Institute).filter(Institute.code == institute_code.lower().strip()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Institute not found")

    ann = Announcement(
        institute_id=inst.id,
        title=req.title.strip(),
        category=req.category.strip().upper(),
        description=req.description.strip(),
        effective_date=req.effective_date,
        batch_grade=req.batch_grade or "All",
        created_by=req.created_by or "Teacher",
        created_at=get_ist_now(),
    )
    db.add(ann)
    db.commit()
    db.refresh(ann)

    # Gather parent push tokens
    tokens = [
        s[0]
        for s in db.query(Student.parent_fcm_token)
        .filter(Student.institute_id == inst.id, Student.parent_fcm_token.isnot(None))
        .distinct()
        .all()
        if s[0]
    ]

    cat_titles = {
        "HOLIDAY": f"🎉 Holiday Declared • {inst.name}",
        "CLASS_CHANGE": f"⏰ Class Schedule Update • {inst.name}",
        "EXAM": f"📝 Exam Notification • {inst.name}",
        "GENERAL": f"📢 Notice • {inst.name}",
    }
    push_title = cat_titles.get(ann.category, f"📢 Announcement • {inst.name}")
    date_suffix = f" (Effective: {ann.effective_date})" if ann.effective_date else ""
    push_body = f"{ann.title}: {ann.description}{date_suffix}"

    notified = 0
    if tokens:
        notified = send_expo_push_batch(
            tokens=tokens,
            title=push_title,
            body=push_body,
            data={"type": "ANNOUNCEMENT", "category": ann.category, "id": ann.id},
        )

    return {
        "status": "ok",
        "announcement_id": ann.id,
        "notified_count": notified,
    }


@app.delete("/api/institutes/{institute_code}/announcements/{announcement_id}")
def delete_announcement(
    institute_code: str,
    announcement_id: int,
    db: Session = Depends(get_db)
):
    inst = db.query(Institute).filter(Institute.code == institute_code.lower().strip()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Institute not found")

    ann = db.query(Announcement).filter(Announcement.institute_id == inst.id, Announcement.id == announcement_id).first()
    if not ann:
        raise HTTPException(status_code=404, detail="Announcement not found")

    db.delete(ann)
    db.commit()
    return {"status": "ok"}


# ---------------------------------------------------------
# Feature 3: Weekly Timetable (Mon - Sun)
# ---------------------------------------------------------
@app.get("/api/institutes/{institute_code}/timetable")
def get_timetable(
    institute_code: str,
    day: Optional[str] = None,
    db: Session = Depends(get_db)
):
    inst = db.query(Institute).filter(Institute.code == institute_code.lower().strip()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Institute not found")

    q = db.query(TimetableSlot).filter(TimetableSlot.institute_id == inst.id)
    if day:
        q = q.filter(TimetableSlot.day.ilike(day.strip()))

    slots = q.order_by(TimetableSlot.id.asc()).all()

    day_order = {
        "Monday": 1,
        "Tuesday": 2,
        "Wednesday": 3,
        "Thursday": 4,
        "Friday": 5,
        "Saturday": 6,
        "Sunday": 7,
    }

    result = [
        {
            "id": s.id,
            "day": s.day,
            "subject": s.subject,
            "time_slot": s.time_slot,
            "teacher": s.teacher,
            "room": s.room,
            "grade": s.grade,
        }
        for s in slots
    ]
    result.sort(key=lambda x: day_order.get(x["day"], 99))
    return result


@app.post("/api/institutes/{institute_code}/timetable")
def add_timetable_slot(
    institute_code: str,
    req: TimetableSlotCreate,
    db: Session = Depends(get_db)
):
    inst = db.query(Institute).filter(Institute.code == institute_code.lower().strip()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Institute not found")

    slot = TimetableSlot(
        institute_id=inst.id,
        day=req.day.strip().capitalize(),
        subject=req.subject.strip(),
        time_slot=req.time_slot.strip(),
        teacher=req.teacher,
        room=req.room,
        grade=req.grade or "All",
    )
    db.add(slot)
    db.commit()
    db.refresh(slot)
    return {"status": "ok", "slot_id": slot.id}


@app.delete("/api/institutes/{institute_code}/timetable/{slot_id}")
def delete_timetable_slot(
    institute_code: str,
    slot_id: int,
    db: Session = Depends(get_db)
):
    inst = db.query(Institute).filter(Institute.code == institute_code.lower().strip()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Institute not found")

    slot = db.query(TimetableSlot).filter(TimetableSlot.institute_id == inst.id, TimetableSlot.id == slot_id).first()
    if not slot:
        raise HTTPException(status_code=404, detail="Timetable slot not found")

    db.delete(slot)
    db.commit()
    return {"status": "ok"}


# ---------------------------------------------------------
# Feature 4 & 5: Tests, Results & Cumulative Tracking
# ---------------------------------------------------------
@app.get("/api/institutes/{institute_code}/tests")
def list_tests(
    institute_code: str,
    db: Session = Depends(get_db)
):
    inst = db.query(Institute).filter(Institute.code == institute_code.lower().strip()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Institute not found")

    tests = (
        db.query(Test)
        .filter(Test.institute_id == inst.id)
        .order_by(Test.test_date.desc(), Test.id.desc())
        .all()
    )

    out = []
    for t in tests:
        scores = db.query(TestScore).filter(TestScore.test_id == t.id).all()
        avg_score = round(sum(s.percentage for s in scores) / len(scores), 1) if scores else None
        out.append({
            "id": t.id,
            "name": t.name,
            "subject": t.subject,
            "test_date": t.test_date.strftime("%Y-%m-%d") if t.test_date else None,
            "max_marks": t.max_marks,
            "grade": t.grade,
            "graded_students_count": len(scores),
            "class_average_pct": avg_score,
        })
    return out


@app.post("/api/institutes/{institute_code}/tests")
def create_test(
    institute_code: str,
    req: TestCreate,
    db: Session = Depends(get_db)
):
    inst = db.query(Institute).filter(Institute.code == institute_code.lower().strip()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Institute not found")

    test_dt = get_ist_now()
    if req.test_date:
        try:
            test_dt = datetime.strptime(req.test_date[:10], "%Y-%m-%d")
        except Exception:
            pass

    test = Test(
        institute_id=inst.id,
        name=req.name.strip(),
        subject=req.subject.strip(),
        test_date=test_dt,
        max_marks=req.max_marks or 100,
        grade=req.grade or "All",
    )
    db.add(test)
    db.commit()
    db.refresh(test)
    return {"status": "ok", "test_id": test.id}


@app.get("/api/institutes/{institute_code}/tests/{test_id}/scores")
def get_test_scores(
    institute_code: str,
    test_id: int,
    db: Session = Depends(get_db)
):
    inst = db.query(Institute).filter(Institute.code == institute_code.lower().strip()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Institute not found")

    test = db.query(Test).filter(Test.institute_id == inst.id, Test.id == test_id).first()
    if not test:
        raise HTTPException(status_code=404, detail="Test not found")

    scores = (
        db.query(TestScore, Student.name)
        .outerjoin(
            Student,
            (TestScore.student_id == Student.student_id) & (Student.institute_id == inst.id),
        )
        .filter(TestScore.test_id == test_id)
        .all()
    )

    return {
        "test": {
            "id": test.id,
            "name": test.name,
            "subject": test.subject,
            "max_marks": test.max_marks,
            "test_date": test.test_date.strftime("%Y-%m-%d") if test.test_date else None,
        },
        "scores": [
            {
                "id": sc[0].id,
                "student_id": sc[0].student_id,
                "student_name": sc[1] or f"Student #{sc[0].student_id}",
                "marks_obtained": sc[0].marks_obtained,
                "percentage": sc[0].percentage,
                "remarks": sc[0].remarks,
            }
            for sc in scores
        ],
    }


@app.post("/api/institutes/{institute_code}/tests/{test_id}/scores")
def submit_test_scores(
    institute_code: str,
    test_id: int,
    req: TestScoresSubmit,
    db: Session = Depends(get_db)
):
    inst = db.query(Institute).filter(Institute.code == institute_code.lower().strip()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Institute not found")

    test = db.query(Test).filter(Test.institute_id == inst.id, Test.id == test_id).first()
    if not test:
        raise HTTPException(status_code=404, detail="Test not found")

    saved_count = 0
    notified_parents = 0

    for item in req.scores:
        student = (
            db.query(Student)
            .filter(Student.institute_id == inst.id, Student.student_id == item.student_id)
            .first()
        )
        pct = round((item.marks_obtained / test.max_marks) * 100) if test.max_marks > 0 else 0

        existing = (
            db.query(TestScore)
            .filter(TestScore.test_id == test.id, TestScore.student_id == item.student_id)
            .first()
        )
        if existing:
            existing.marks_obtained = item.marks_obtained
            existing.percentage = pct
            existing.remarks = item.remarks
        else:
            new_score = TestScore(
                test_id=test.id,
                student_id=item.student_id,
                marks_obtained=item.marks_obtained,
                percentage=pct,
                remarks=item.remarks,
            )
            db.add(new_score)
        saved_count += 1

        # Send push notification to student's parent
        if student and student.parent_fcm_token:
            title = f"📝 Test Score: {test.name}"
            body = f"{student.name} scored {item.marks_obtained}/{test.max_marks} ({pct}%) in {test.subject}."
            if item.remarks:
                body += f" Note: {item.remarks}"
            send_expo_push_notification(
                token=student.parent_fcm_token,
                title=title,
                body=body,
                data={
                    "type": "TEST_RESULT",
                    "test_id": test.id,
                    "student_id": item.student_id,
                    "percentage": pct,
                },
            )
            notified_parents += 1

    db.commit()
    return {
        "status": "ok",
        "saved_scores": saved_count,
        "notified_parents": notified_parents,
    }


@app.get("/api/institutes/{institute_code}/students/{student_id}/tests")
def get_student_tests_cumulative(
    institute_code: str,
    student_id: str,
    db: Session = Depends(get_db)
):
    """
    Cumulative Tracking of Results from Test 1 -> Test 2 -> Test 3 ...
    Computes delta progress, trends, averages, and best scores.
    """
    inst = db.query(Institute).filter(Institute.code == institute_code.lower().strip()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Institute not found")

    student = (
        db.query(Student)
        .filter(Student.institute_id == inst.id, Student.student_id == student_id)
        .first()
    )
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")

    scores = (
        db.query(TestScore, Test)
        .join(Test, TestScore.test_id == Test.id)
        .filter(Test.institute_id == inst.id, TestScore.student_id == student_id)
        .order_by(Test.test_date.asc(), Test.id.asc())
        .all()
    )

    timeline = []
    prev_pct = None
    baseline_pct = None
    total_pct = 0

    for idx, (score, test) in enumerate(scores):
        if baseline_pct is None:
            baseline_pct = score.percentage

        delta_prev = (score.percentage - prev_pct) if prev_pct is not None else 0
        delta_baseline = score.percentage - baseline_pct
        prev_pct = score.percentage
        total_pct += score.percentage

        timeline.append({
            "test_id": test.id,
            "test_name": test.name,
            "subject": test.subject,
            "test_date": test.test_date.strftime("%Y-%m-%d") if test.test_date else None,
            "max_marks": test.max_marks,
            "marks_obtained": score.marks_obtained,
            "percentage": score.percentage,
            "remarks": score.remarks,
            "delta_from_previous": delta_prev,
            "delta_from_baseline": delta_baseline,
            "test_index": idx + 1,
        })

    count = len(timeline)
    avg_pct = round(total_pct / count, 1) if count > 0 else 0
    highest_pct = max([t["percentage"] for t in timeline]) if count > 0 else 0
    lowest_pct = min([t["percentage"] for t in timeline]) if count > 0 else 0
    overall_improvement = (timeline[-1]["percentage"] - timeline[0]["percentage"]) if count > 1 else 0

    if overall_improvement > 0:
        trend = "IMPROVING"
    elif overall_improvement < 0:
        trend = "DECLINING"
    else:
        trend = "CONSISTENT"

    return {
        "student_id": student.student_id,
        "student_name": student.name,
        "grade": student.grade,
        "total_tests": count,
        "average_percentage": avg_pct,
        "highest_percentage": highest_pct,
        "lowest_percentage": lowest_pct,
        "overall_improvement": overall_improvement,
        "trend": trend,
        "timeline": timeline,
    }


# ---------------------------------------------------------
# Teachers Management
# ---------------------------------------------------------
@app.get("/api/institutes/{institute_code}/teachers")
def list_teachers(
    institute_code: str,
    db: Session = Depends(get_db)
):
    inst = db.query(Institute).filter(Institute.code == institute_code.lower().strip()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Institute not found")
    teachers = db.query(Teacher).filter(Teacher.institute_id == inst.id).all()
    return [
        {
            "id": t.id,
            "name": t.name,
            "phone": t.phone,
            "subject": t.subject,
            "is_active": t.is_active,
        }
        for t in teachers
    ]


@app.post("/api/institutes/{institute_code}/teachers")
def add_teacher(
    institute_code: str,
    req: TeacherCreate,
    db: Session = Depends(get_db)
):
    inst = db.query(Institute).filter(Institute.code == institute_code.lower().strip()).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Institute not found")

    teacher = Teacher(
        institute_id=inst.id,
        name=req.name.strip(),
        phone=req.phone.strip(),
        subject=req.subject,
    )
    db.add(teacher)
    db.commit()
    db.refresh(teacher)
    return {"status": "ok", "teacher_id": teacher.id}


@app.get("/ping", response_class=PlainTextResponse)
@app.head("/ping")
@app.head("/")
@app.head("/health")
def ping():
    """Ultra-lightweight 4-byte ping endpoint for uptime monitors and keep-alive cron jobs."""
    return "pong"


@app.get("/health")
def health():
    return {
        "status": "online",
        "mode": "multi-tenant",
        "time": format_punch_time(get_ist_now()),
        "timezone": "Asia/Kolkata (IST +05:30)",
    }


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
