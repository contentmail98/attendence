import os
from datetime import datetime
from zoneinfo import ZoneInfo
from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, create_engine, UniqueConstraint, text, inspect
from sqlalchemy.orm import declarative_base, sessionmaker, relationship
from dotenv import load_dotenv

load_dotenv()

IST = ZoneInfo("Asia/Kolkata")

def get_ist_now():
    """Returns the current date and time in Indian Standard Time (IST)."""
    return datetime.now(IST).replace(tzinfo=None)

# Environment variable DATABASE_URL takes priority (PostgreSQL on cloud, SQLite locally)
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./attendance.db")

# Fix for older postgres:// URLs (Render / Heroku) -> postgresql://
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

connect_args = {"check_same_thread": False} if "sqlite" in DATABASE_URL else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class Institute(Base):
    __tablename__ = "institutes"

    id = Column(Integer, primary_key=True, index=True)
    code = Column(String, unique=True, index=True, nullable=False)  # e.g. "apex", "allen"
    name = Column(String, nullable=False)
    contact_person = Column(String, nullable=True)
    contact_phone = Column(String, nullable=True)
    contact_email = Column(String, nullable=True)
    address = Column(String, nullable=True)
    is_active = Column(Boolean, default=True)
    integration_date = Column(DateTime, nullable=True)  # Only show attendance records from this date onwards
    created_at = Column(DateTime, default=get_ist_now)

    students = relationship("Student", back_populates="institute", cascade="all, delete-orphan")
    attendance_records = relationship("AttendanceRecord", back_populates="institute", cascade="all, delete-orphan")


class Student(Base):
    __tablename__ = "students"

    id = Column(Integer, primary_key=True, index=True)
    institute_id = Column(Integer, ForeignKey("institutes.id"), index=True, nullable=False)
    student_id = Column(String, index=True, nullable=False)  # Biometric device Employee ID
    name = Column(String, nullable=False)
    grade = Column(String, nullable=True)
    parent_name = Column(String, nullable=True)
    parent_phone = Column(String, index=True, nullable=False)
    parent_fcm_token = Column(String, nullable=True)  # Device token for push notifications
    created_at = Column(DateTime, default=get_ist_now)

    # Scoped uniqueness: Student ID must be unique within an institute
    __table_args__ = (UniqueConstraint("institute_id", "student_id", name="uq_institute_student"),)

    institute = relationship("Institute", back_populates="students")


class AttendanceRecord(Base):
    __tablename__ = "attendance_records"

    id = Column(Integer, primary_key=True, index=True)
    institute_id = Column(Integer, ForeignKey("institutes.id"), index=True, nullable=False)
    student_id = Column(String, index=True, nullable=False)
    punch_time = Column(DateTime, default=get_ist_now, nullable=False)
    punch_type = Column(String, nullable=False)  # 'ENTRY' or 'EXIT'
    device_name = Column(String, nullable=True)
    notes = Column(String, nullable=True)

    institute = relationship("Institute", back_populates="attendance_records")


def init_db():
    Base.metadata.create_all(bind=engine)

    # Automatic schema migration for existing databases (PostgreSQL & SQLite)
    try:
        inspector = inspect(engine)
        table_names = inspector.get_table_names()

        if "institutes" in table_names:
            cols = [c["name"] for c in inspector.get_columns("institutes")]
            if "integration_date" not in cols:
                with engine.begin() as conn:
                    if "sqlite" in DATABASE_URL:
                        conn.execute(text("ALTER TABLE institutes ADD COLUMN integration_date DATETIME"))
                    else:
                        conn.execute(text("ALTER TABLE institutes ADD COLUMN IF NOT EXISTS integration_date TIMESTAMP WITHOUT TIME ZONE"))

        if "students" in table_names:
            cols = [c["name"] for c in inspector.get_columns("students")]
            if "institute_id" not in cols:
                with engine.begin() as conn:
                    conn.execute(text("ALTER TABLE students ADD COLUMN institute_id INTEGER DEFAULT 1"))

        if "attendance_records" in table_names:
            cols = [c["name"] for c in inspector.get_columns("attendance_records")]
            if "institute_id" not in cols:
                with engine.begin() as conn:
                    conn.execute(text("ALTER TABLE attendance_records ADD COLUMN institute_id INTEGER DEFAULT 1"))
    except Exception as e:
        print("Schema auto-migration error:", e)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
