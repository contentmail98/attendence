"""
Script to populate sample students into the database for testing.
"""
from database import init_db, SessionLocal, Student

init_db()
db = SessionLocal()

sample_students = [
    {
        "student_id": "101",
        "name": "Rohan Sharma",
        "grade": "Class 10 - Batch A",
        "parent_name": "Suresh Sharma",
        "parent_phone": "9876543210"
    },
    {
        "student_id": "102",
        "name": "Priya Patel",
        "grade": "Class 12 - Science",
        "parent_name": "Vikram Patel",
        "parent_phone": "9123456789"
    }
]

for item in sample_students:
    existing = db.query(Student).filter(Student.student_id == item["student_id"]).first()
    if not existing:
        student = Student(**item)
        db.add(student)
        print(f"Added student: {item['name']} (ID: {item['student_id']}) with Parent Phone: {item['parent_phone']}")
    else:
        print(f"Student {item['student_id']} already exists.")

db.commit()
db.close()
print("Sample data populated successfully!")
