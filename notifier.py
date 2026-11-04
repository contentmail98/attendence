"""
Notification Service: Supports Expo Push Notification Service directly,
as well as optional Firebase Cloud Messaging (FCM).
"""

import logging
import requests
from typing import Optional

logger = logging.getLogger("NotificationService")

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"


def send_expo_push_notification(
    token: str,
    title: str,
    body: str,
    data: Optional[dict] = None
) -> bool:
    """
    Sends a push notification directly to an Expo mobile app token (ExponentPushToken[...]).
    Works out-of-the-box with Expo push notifications.
    """
    if not token or not token.startswith("ExponentPushToken"):
        logger.warning("Token %s is not a valid Expo Push Token", token)
        return False

    message = {
        "to": token,
        "sound": "default",
        "title": title,
        "body": body,
        "channelId": "attendance-alerts",
        "priority": "high",
        "_displayInForeground": True,
        "data": data or {},
    }

    headers = {
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json",
    }

    try:
        response = requests.post(EXPO_PUSH_URL, json=message, headers=headers, timeout=5)
        res_data = response.json()
        logger.info("Push notification sent: %s", res_data)
        return response.status_code == 200
    except Exception as e:
        logger.error("Failed to send Expo push notification: %s", str(e))
        return False
