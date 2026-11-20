"""
Notification Service: Expo Push Notification Service with FCM V1 support.
- Uses Expo Push API (which handles FCM V1 internally via your EAS credentials)
- Expo push tokens (ExponentPushToken[...]) work automatically once
  the FCM V1 Service Account key is uploaded to your EAS project.
"""

import logging
import os
import requests
from typing import Optional

logger = logging.getLogger("NotificationService")

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"

# Optional: Expo access token for authenticated requests (set EXPO_ACCESS_TOKEN env var)
# Get from: https://expo.dev/accounts/[account]/settings/access-tokens
EXPO_ACCESS_TOKEN = os.getenv("EXPO_ACCESS_TOKEN", "")


def send_expo_push_notification(
    token: str,
    title: str,
    body: str,
    data: Optional[dict] = None
) -> bool:
    """
    Sends a push notification via the Expo Push API.
    Supports ExponentPushToken (Expo managed) tokens.
    FCM V1 is handled by Expo automatically once the
    Firebase Service Account key is uploaded to EAS credentials.
    """
    if not token:
        logger.warning("No push token provided — notification skipped")
        return False

    is_expo_token = token.startswith("ExponentPushToken") or token.startswith("ExpoPushToken")
    if not is_expo_token:
        logger.warning("Token '%s...' is not a valid Expo Push Token — skipping", token[:30])
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

    # Include Expo access token if configured (improves rate limits and reliability)
    if EXPO_ACCESS_TOKEN:
        headers["Authorization"] = f"Bearer {EXPO_ACCESS_TOKEN}"

    try:
        response = requests.post(EXPO_PUSH_URL, json=message, headers=headers, timeout=8)
        res_data = response.json()

        # Parse Expo's response to detect delivery errors
        ticket = res_data.get("data", {})
        if ticket.get("status") == "error":
            err = ticket.get("message", "Unknown error")
            details = ticket.get("details", {})
            error_type = details.get("error", "")

            if error_type == "InvalidCredentials":
                logger.error(
                    "❌ FCM credentials missing or invalid. "
                    "Upload your Firebase Service Account JSON to EAS: "
                    "run 'eas credentials' and add FCM V1 key. "
                    "Error: %s", err
                )
            elif error_type == "DeviceNotRegistered":
                logger.warning("📵 Device token is no longer valid (app uninstalled?): %s...", token[:30])
            else:
                logger.error("Push notification error [%s]: %s", error_type, err)
            return False

        logger.info("✅ Push notification sent successfully to %s...", token[:30])
        return True

    except Exception as e:
        logger.error("Failed to send Expo push notification: %s", str(e))
        return False
