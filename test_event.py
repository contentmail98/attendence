"""
Test script to simulate a biometric punch for a specific coaching institute tenant.
"""

import sys
import requests
from datetime import datetime

# You can pass the institute code as an argument: python test_event.py allen 101
INSTITUTE_CODE = sys.argv[1] if len(sys.argv) > 1 else "apex"
STUDENT_ID = sys.argv[2] if len(sys.argv) > 2 else "101"

WEBHOOK_URL = f"http://127.0.0.1:8000/api/institutes/{INSTITUTE_CODE}/events"

sample_event = {
    "ipAddress": "192.168.1.120",
    "portNo": 80,
    "dateTime": datetime.now().isoformat(),
    "eventType": "AccessControllerEvent",
    "deviceName": f"{INSTITUTE_CODE.upper()} Main Gate Scanner",
    "AccessControllerEvent": {
        "deviceName": f"{INSTITUTE_CODE.upper()} Terminal",
        "majorEventType": 5,
        "subEventType": 75,
        "employeeNoString": STUDENT_ID,
        "name": "Biometric User",
        "attendanceStatus": "checkIn",
    }
}

if __name__ == "__main__":
    print(f"Triggering biometric scan for Institute [{INSTITUTE_CODE.upper()}], Student ID #{STUDENT_ID}...")
    print(f"Target URL: {WEBHOOK_URL}")
    try:
        res = requests.post(WEBHOOK_URL, json=sample_event, timeout=5)
        print(f"Status Code: {res.status_code}")
        print(f"Response: {res.text}")
    except Exception as e:
        print(f"Error connecting: {e}")
