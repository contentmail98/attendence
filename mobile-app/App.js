import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Alert,
  SafeAreaView,
  StatusBar,
  Platform,
  RefreshControl,
  ScrollView,
  Linking,
  Vibration,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import * as Updates from 'expo-updates';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AcademyEmblem,
  ChimeIcon,
  ExitDoorIcon,
  SyncCycleIcon,
  PunchDirectionIcon,
  ScannerTargetIcon,
  CalendarBadgeIcon,
  StatusCrest,
  EmptyAttendanceGraphic,
} from './components/CustomIcons';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    priority: Notifications.AndroidNotificationPriority.MAX,
  }),
});

// Production Render Server URL
const SERVER_URL = 'https://attendance-api-iw7z.onrender.com';

function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Request timed out after ${timeoutMs / 1000}s. Server is not reachable.`));
    }, timeoutMs);

    fetch(url, { ...options, signal: controller.signal })
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
          reject(new Error(`Request timed out after ${timeoutMs / 1000}s. Server not reachable.`));
        } else {
          reject(err);
        }
      });
  });
}

const DAYS_OF_WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export default function App() {
  // Login form state
  const [instituteCode, setInstituteCode] = useState('');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isRestoringSession, setIsRestoringSession] = useState(true);

  // User session state
  const [roles, setRoles] = useState([]); // ['teacher'], ['parent'], or ['teacher', 'parent']
  const [activeRole, setActiveRole] = useState('parent'); // 'parent' or 'teacher'
  const [teacherData, setTeacherData] = useState(null);
  const [students, setStudents] = useState([]);
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [instituteMeta, setInstituteMeta] = useState(null);
  const [deviceToken, setDeviceToken] = useState(null);

  // Active navigation tab
  // For Parent: 'attendance' | 'announcements' | 'timetable' | 'tests'
  // For Teacher: 'early_out' | 'notices' | 'timetable_mgmt' | 'tests_mgmt'
  const [parentTab, setParentTab] = useState('attendance');
  const [teacherTab, setTeacherTab] = useState('early_out');

  // Parent Data
  const [attendanceLogs, setAttendanceLogs] = useState([]);
  const [announcements, setAnnouncements] = useState([]);
  const [timetableSlots, setTimetableSlots] = useState([]);
  const [selectedTimetableDay, setSelectedTimetableDay] = useState(DAYS_OF_WEEK[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1]);
  const [cumulativeTests, setCumulativeTests] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // Teacher Management State
  const [allStudents, setAllStudents] = useState([]);
  const [earlyOutStudentId, setEarlyOutStudentId] = useState('');
  const [earlyOutReason, setEarlyOutReason] = useState('Medical / Sick');
  const [earlyOutNotes, setEarlyOutNotes] = useState('');
  const [earlyOutSubmitting, setEarlyOutSubmitting] = useState(false);

  // Teacher Announcement Form
  const [annTitle, setAnnTitle] = useState('');
  const [annCategory, setAnnCategory] = useState('HOLIDAY');
  const [annDate, setAnnDate] = useState('');
  const [annDesc, setAnnDesc] = useState('');
  const [annSubmitting, setAnnSubmitting] = useState(false);

  // Teacher Timetable Form
  const [ttDay, setTtDay] = useState('Monday');
  const [ttSubject, setTtSubject] = useState('');
  const [ttTimeSlot, setTtTimeSlot] = useState('');
  const [ttTeacher, setTtTeacher] = useState('');
  const [ttRoom, setTtRoom] = useState('');
  const [ttSubmitting, setTtSubmitting] = useState(false);

  // Teacher Tests & Grading Form
  const [teacherTests, setTeacherTests] = useState([]);
  const [selectedTestForGrading, setSelectedTestForGrading] = useState(null);
  const [testGradesMap, setTestGradesMap] = useState({});
  const [testRemarksMap, setTestRemarksMap] = useState({});
  const [newTestName, setNewTestName] = useState('');
  const [newTestSubject, setNewTestSubject] = useState('');
  const [newTestMaxMarks, setNewTestMaxMarks] = useState('100');
  const [testSubmitting, setTestSubmitting] = useState(false);

  // Sync push token to server
  const syncPushTokenToServer = useCallback(async (tokenToSync, instCode, userPhone) => {
    if (!tokenToSync || !instCode || !userPhone) return;
    try {
      await fetch(`${SERVER_URL}/api/parents/register-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          institute_code: instCode.trim().toLowerCase(),
          parent_phone: userPhone.trim(),
          expo_push_token: tokenToSync,
        }),
      });
      console.log('Push token synced to server for:', userPhone);
    } catch (e) {
      console.log('Push token sync error:', e);
    }
  }, []);

  // Restore session on app launch
  useEffect(() => {
    const restoreSession = async () => {
      try {
        const savedSession = await AsyncStorage.getItem('@auth_session');
        if (savedSession) {
          const parsed = JSON.parse(savedSession);
          const { instituteCode: savedCode, phone: savedPhone, activeRole: savedRole, selectedStudentId } = parsed;
          if (savedCode && savedPhone) {
            setInstituteCode(savedCode);
            setPhone(savedPhone);

            const res = await fetchWithTimeout(
              `${SERVER_URL}/api/institutes/${savedCode.trim().toLowerCase()}/auth/login`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: savedPhone.trim() }),
              },
              8000
            );

            if (res.ok) {
              const data = await res.json();
              setRoles(data.roles || ['parent']);
              setInstituteMeta(data.institute);
              setTeacherData(data.teacher || null);
              setStudents(data.students || []);

              const roleToSet = savedRole && data.roles?.includes(savedRole) ? savedRole : (data.primary_role || 'parent');
              setActiveRole(roleToSet);

              if (Array.isArray(data.students) && data.students.length > 0) {
                const matched = selectedStudentId
                  ? data.students.find((s) => s.student_id === selectedStudentId)
                  : data.students[0];
                const active = matched || data.students[0];
                setSelectedStudent(active);
                loadStudentData(active.student_id, savedCode);
              }

              if (roleToSet === 'teacher' || data.roles?.includes('teacher')) {
                loadTeacherData(savedCode);
              }

              setIsLoggedIn(true);
            }
          }
        }
      } catch (err) {
        console.log('Session restore error:', err);
      } finally {
        setIsRestoringSession(false);
      }
    };

    restoreSession();
  }, []);

  // Check for OTA updates
  useEffect(() => {
    async function checkForOTAUpdate() {
      if (__DEV__) return;
      try {
        const update = await Updates.checkForUpdateAsync();
        if (update.isAvailable) {
          await Updates.fetchUpdateAsync();
          Alert.alert(
            'App Updated',
            'A new version has been downloaded. The app will restart to apply the update.',
            [{ text: 'Restart', onPress: () => Updates.reloadAsync() }]
          );
        }
      } catch (e) {
        console.log('OTA update check error:', e);
      }
    }
    checkForOTAUpdate();
  }, []);

  // Register push notifications
  useEffect(() => {
    registerForPushNotificationsAsync().then((token) => {
      if (token) setDeviceToken(token);
    });
  }, []);

  // Keep server updated with push token
  useEffect(() => {
    if (isLoggedIn && deviceToken && instituteCode && phone) {
      syncPushTokenToServer(deviceToken, instituteCode, phone);
    }
  }, [isLoggedIn, deviceToken, instituteCode, phone, syncPushTokenToServer]);

  // Live polling for biometric attendance updates
  useEffect(() => {
    if (!isLoggedIn || !selectedStudent || activeRole !== 'parent') return;

    let lastKnownPunchId = null;

    const pollInterval = setInterval(async () => {
      try {
        const res = await fetchWithTimeout(
          `${SERVER_URL}/api/institutes/${instituteCode.trim().toLowerCase()}/students/${selectedStudent.student_id}/attendance`,
          {},
          5000
        );
        if (!res.ok) return;
        const logs = await res.json();
        if (Array.isArray(logs) && logs.length > 0) {
          const latest = logs[0];
          if (lastKnownPunchId === null) {
            lastKnownPunchId = latest.id;
          } else if (latest.id !== lastKnownPunchId) {
            lastKnownPunchId = latest.id;
            setAttendanceLogs(logs);

            try {
              const isEntry = latest.punch_type === 'ENTRY';
              Vibration.vibrate([0, 500, 200, 500]);
              await Notifications.scheduleNotificationAsync({
                content: {
                  title: latest.is_early_exit ? '🚨 Early Departure Recorded' : (isEntry ? 'Student Check-In Verified' : 'Student Check-Out Verified'),
                  body: latest.is_early_exit
                    ? `${selectedStudent.name} left early. Reason: ${latest.reason || 'Not specified'}.`
                    : (isEntry
                      ? `${selectedStudent.name} entered ${selectedStudent.institute_name || 'Center'}.`
                      : `${selectedStudent.name} has left the center.`),
                  sound: 'default',
                  channelId: 'attendance-alerts',
                  priority: Notifications.AndroidNotificationPriority.MAX,
                },
                trigger: null,
              });
            } catch (notifErr) {
              console.log('Notification trigger error:', notifErr);
            }
          }
        }
      } catch (err) {
        // silent polling
      }
    }, 4000);

    return () => clearInterval(pollInterval);
  }, [isLoggedIn, selectedStudent, instituteCode, activeRole]);

  async function registerForPushNotificationsAsync() {
    let token = null;
    if (Platform.OS === 'android') {
      try {
        await Notifications.setNotificationChannelAsync('attendance-alerts', {
          name: 'Loud Attendance Alerts',
          importance: Notifications.AndroidImportance.MAX,
          sound: 'default',
          vibrationPattern: [0, 500, 250, 500, 250, 500],
          lightColor: '#4338CA',
          enableLights: true,
          enableVibrate: true,
          showBadge: true,
          lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        });
      } catch (channelErr) {
        console.log('Channel setup error:', channelErr);
      }
    }

    if (Device.isDevice) {
      try {
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;
        if (existingStatus !== 'granted') {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }

        if (finalStatus !== 'granted') return null;

        const projectId =
          Constants?.expoConfig?.extra?.eas?.projectId ??
          Constants?.easConfig?.projectId;

        try {
          const expoTokenData = await Notifications.getExpoPushTokenAsync({ projectId });
          token = expoTokenData?.data;
        } catch (pushErr) {
          const fallbackToken = await Notifications.getExpoPushTokenAsync();
          token = fallbackToken?.data;
        }
      } catch (deviceErr) {
        console.error('Push registration error:', deviceErr);
      }
    }
    return token;
  }

  // Unified Login
  const handleLogin = async () => {
    const cleanCode = instituteCode.trim().toLowerCase();
    const cleanPhone = phone.trim();

    if (!cleanCode) {
      Alert.alert('Required', 'Please enter your Coaching Institute Code.');
      return;
    }
    if (!cleanPhone) {
      Alert.alert('Required', 'Please enter your registered mobile number.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetchWithTimeout(
        `${SERVER_URL}/api/institutes/${cleanCode}/auth/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: cleanPhone }),
        },
        10000
      );

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.detail || `Login failed (status ${res.status})`);
      }

      const data = await res.json();
      const userRoles = data.roles || ['parent'];
      setRoles(userRoles);
      setInstituteMeta(data.institute);
      setTeacherData(data.teacher || null);
      setStudents(data.students || []);

      const chosenRole = userRoles.includes('teacher') ? 'teacher' : 'parent';
      setActiveRole(chosenRole);

      let firstStudent = null;
      if (Array.isArray(data.students) && data.students.length > 0) {
        firstStudent = data.students[0];
        setSelectedStudent(firstStudent);
        loadStudentData(firstStudent.student_id, cleanCode);
      }

      if (userRoles.includes('teacher')) {
        loadTeacherData(cleanCode);
      }

      setIsLoggedIn(true);

      // Save persistent session
      await AsyncStorage.setItem(
        '@auth_session',
        JSON.stringify({
          instituteCode: cleanCode,
          phone: cleanPhone,
          activeRole: chosenRole,
          selectedStudentId: firstStudent ? firstStudent.student_id : null,
        })
      );

      if (deviceToken) {
        syncPushTokenToServer(deviceToken, cleanCode, cleanPhone);
      }
    } catch (err) {
      Alert.alert('Login Failed', err.message || 'Unable to connect to server.');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await AsyncStorage.removeItem('@auth_session');
    } catch (e) {}
    setIsLoggedIn(false);
    setRoles([]);
    setActiveRole('parent');
    setTeacherData(null);
    setStudents([]);
    setSelectedStudent(null);
    setAttendanceLogs([]);
    setAnnouncements([]);
    setTimetableSlots([]);
    setCumulativeTests(null);
  };

  // Switch role between Teacher Mode and Parent Mode
  const switchRole = async (newRole) => {
    setActiveRole(newRole);
    try {
      const savedSession = await AsyncStorage.getItem('@auth_session');
      if (savedSession) {
        const parsed = JSON.parse(savedSession);
        parsed.activeRole = newRole;
        await AsyncStorage.setItem('@auth_session', JSON.stringify(parsed));
      }
    } catch (e) {}

    if (newRole === 'teacher') {
      loadTeacherData(instituteCode);
    } else if (selectedStudent) {
      loadStudentData(selectedStudent.student_id, instituteCode);
    }
  };

  // Load all student/parent dashboard data
  const loadStudentData = async (studentId, code) => {
    const c = (code || instituteCode || '').trim().toLowerCase();
    if (!c || !studentId) return;

    fetchAttendance(studentId, c);
    fetchAnnouncements(c);
    fetchTimetable(c);
    fetchCumulativeTests(studentId, c);
  };

  // Load all teacher dashboard data
  const loadTeacherData = async (code) => {
    const c = (code || instituteCode || '').trim().toLowerCase();
    if (!c) return;

    fetchInstituteStudents(c);
    fetchAnnouncements(c);
    fetchTimetable(c);
    fetchTeacherTests(c);
  };

  const fetchAttendance = async (studentId, code) => {
    const c = (code || instituteCode || '').trim().toLowerCase();
    try {
      const res = await fetchWithTimeout(
        `${SERVER_URL}/api/institutes/${c}/students/${studentId}/attendance`,
        {},
        8000
      );
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) setAttendanceLogs(data);
      }
    } catch (e) {
      console.log('Error fetching attendance:', e);
    }
  };

  const fetchAnnouncements = async (code) => {
    const c = (code || instituteCode || '').trim().toLowerCase();
    try {
      const res = await fetchWithTimeout(`${SERVER_URL}/api/institutes/${c}/announcements`, {}, 8000);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) setAnnouncements(data);
      }
    } catch (e) {
      console.log('Error fetching announcements:', e);
    }
  };

  const fetchTimetable = async (code) => {
    const c = (code || instituteCode || '').trim().toLowerCase();
    try {
      const res = await fetchWithTimeout(`${SERVER_URL}/api/institutes/${c}/timetable`, {}, 8000);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) setTimetableSlots(data);
      }
    } catch (e) {
      console.log('Error fetching timetable:', e);
    }
  };

  const fetchCumulativeTests = async (studentId, code) => {
    const c = (code || instituteCode || '').trim().toLowerCase();
    try {
      const res = await fetchWithTimeout(
        `${SERVER_URL}/api/institutes/${c}/students/${studentId}/tests`,
        {},
        8000
      );
      if (res.ok) {
        const data = await res.json();
        setCumulativeTests(data);
      }
    } catch (e) {
      console.log('Error fetching cumulative tests:', e);
    }
  };

  const fetchInstituteStudents = async (code) => {
    const c = (code || instituteCode || '').trim().toLowerCase();
    try {
      const res = await fetchWithTimeout(`${SERVER_URL}/api/institutes/${c}/students`, {}, 8000);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setAllStudents(data);
          if (data.length > 0 && !earlyOutStudentId) {
            setEarlyOutStudentId(data[0].student_id);
          }
        }
      }
    } catch (e) {
      console.log('Error fetching institute students:', e);
    }
  };

  const fetchTeacherTests = async (code) => {
    const c = (code || instituteCode || '').trim().toLowerCase();
    try {
      const res = await fetchWithTimeout(`${SERVER_URL}/api/institutes/${c}/tests`, {}, 8000);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) setTeacherTests(data);
      }
    } catch (e) {
      console.log('Error fetching teacher tests:', e);
    }
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    if (activeRole === 'parent' && selectedStudent) {
      await Promise.all([
        fetchAttendance(selectedStudent.student_id, instituteCode),
        fetchAnnouncements(instituteCode),
        fetchTimetable(instituteCode),
        fetchCumulativeTests(selectedStudent.student_id, instituteCode),
      ]);
    } else if (activeRole === 'teacher') {
      await Promise.all([
        fetchInstituteStudents(instituteCode),
        fetchAnnouncements(instituteCode),
        fetchTimetable(instituteCode),
        fetchTeacherTests(instituteCode),
      ]);
    }
    setRefreshing(false);
  }, [activeRole, selectedStudent, instituteCode]);

  // Test sound function
  const handleTestSound = async () => {
    try {
      Vibration.vibrate([0, 500, 200, 500, 200, 500]);
      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Loud Attendance Alert Test',
          body: 'Attendance alert chime, heads-up banner, and vibration are active!',
          sound: 'default',
          channelId: 'attendance-alerts',
          priority: Notifications.AndroidNotificationPriority.MAX,
        },
        trigger: null,
      });
      Alert.alert('Alert Triggered', 'High-priority chime and vibration tested successfully!');
    } catch (err) {
      console.log('Sound test error:', err);
    }
  };

  // --- TEACHER ACTIONS ---
  // 1. Submit Early Out
  const handleEarlyOutSubmit = async () => {
    if (!earlyOutStudentId) {
      Alert.alert('Required', 'Please select a student.');
      return;
    }
    if (!earlyOutReason.trim()) {
      Alert.alert('Required', 'Please provide an early exit reason.');
      return;
    }

    setEarlyOutSubmitting(true);
    try {
      const c = instituteCode.trim().toLowerCase();
      const res = await fetchWithTimeout(
        `${SERVER_URL}/api/institutes/${c}/early-exit`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            student_id: earlyOutStudentId,
            reason: earlyOutReason.trim(),
            notes: earlyOutNotes.trim() || undefined,
            device_name: teacherData?.name ? `Teacher: ${teacherData.name}` : 'Teacher Portal',
          }),
        },
        10000
      );

      if (!res.ok) throw new Error('Failed to record early exit.');
      const data = await res.json();
      Alert.alert(
        'Early Exit Recorded',
        `Early exit marked for student #${earlyOutStudentId}. Push notification sent to the parent instantly!`
      );
      setEarlyOutNotes('');
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to submit early exit.');
    } finally {
      setEarlyOutSubmitting(false);
    }
  };

  // 2. Submit Announcement / Holiday
  const handleAnnouncementSubmit = async () => {
    if (!annTitle.trim() || !annDesc.trim()) {
      Alert.alert('Required', 'Please enter Title and Description.');
      return;
    }

    setAnnSubmitting(true);
    try {
      const c = instituteCode.trim().toLowerCase();
      const res = await fetchWithTimeout(
        `${SERVER_URL}/api/institutes/${c}/announcements`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: annTitle.trim(),
            category: annCategory,
            description: annDesc.trim(),
            effective_date: annDate.trim() || undefined,
            batch_grade: 'All',
            created_by: teacherData?.name || 'Faculty',
          }),
        },
        10000
      );

      if (!res.ok) throw new Error('Failed to post announcement.');
      const data = await res.json();
      Alert.alert(
        'Announcement Broadcasted',
        `Notice posted and push notification sent to ${data.notified_count || 'all'} registered parent devices!`
      );
      setAnnTitle('');
      setAnnDesc('');
      setAnnDate('');
      fetchAnnouncements(c);
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to post announcement.');
    } finally {
      setAnnSubmitting(false);
    }
  };

  // 3. Delete Announcement
  const handleDeleteAnnouncement = async (annId) => {
    Alert.alert('Confirm Delete', 'Delete this notice?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            const c = instituteCode.trim().toLowerCase();
            await fetch(`${SERVER_URL}/api/institutes/${c}/announcements/${annId}`, { method: 'DELETE' });
            fetchAnnouncements(c);
          } catch (e) {}
        },
      },
    ]);
  };

  // 4. Submit Timetable Slot
  const handleTimetableSubmit = async () => {
    if (!ttSubject.trim() || !ttTimeSlot.trim()) {
      Alert.alert('Required', 'Please enter Subject and Time Slot (e.g. 04:00 PM - 05:30 PM).');
      return;
    }

    setTtSubmitting(true);
    try {
      const c = instituteCode.trim().toLowerCase();
      const res = await fetchWithTimeout(
        `${SERVER_URL}/api/institutes/${c}/timetable`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            day: ttDay,
            subject: ttSubject.trim(),
            time_slot: ttTimeSlot.trim(),
            teacher: ttTeacher.trim() || (teacherData?.name || undefined),
            room: ttRoom.trim() || undefined,
            grade: 'All',
          }),
        },
        10000
      );

      if (!res.ok) throw new Error('Failed to add timetable slot.');
      Alert.alert('Slot Added', `Class schedule added for ${ttDay}!`);
      setTtSubject('');
      setTtTimeSlot('');
      setTtRoom('');
      fetchTimetable(c);
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to add timetable slot.');
    } finally {
      setTtSubmitting(false);
    }
  };

  // 5. Delete Timetable Slot
  const handleDeleteTimetableSlot = async (slotId) => {
    Alert.alert('Confirm Delete', 'Delete this timetable slot?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            const c = instituteCode.trim().toLowerCase();
            await fetch(`${SERVER_URL}/api/institutes/${c}/timetable/${slotId}`, { method: 'DELETE' });
            fetchTimetable(c);
          } catch (e) {}
        },
      },
    ]);
  };

  // 6. Create Test
  const handleCreateTest = async () => {
    if (!newTestName.trim() || !newTestSubject.trim()) {
      Alert.alert('Required', 'Please enter Test Name and Subject.');
      return;
    }

    setTestSubmitting(true);
    try {
      const c = instituteCode.trim().toLowerCase();
      const res = await fetchWithTimeout(
        `${SERVER_URL}/api/institutes/${c}/tests`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: newTestName.trim(),
            subject: newTestSubject.trim(),
            max_marks: parseInt(newTestMaxMarks, 10) || 100,
            grade: 'All',
          }),
        },
        10000
      );

      if (!res.ok) throw new Error('Failed to create test.');
      Alert.alert('Test Created', 'New test created! You can now grade students.');
      setNewTestName('');
      setNewTestSubject('');
      fetchTeacherTests(c);
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to create test.');
    } finally {
      setTestSubmitting(false);
    }
  };

  // 7. Load scores for grading a specific test
  const handleSelectTestForGrading = async (test) => {
    setSelectedTestForGrading(test);
    try {
      const c = instituteCode.trim().toLowerCase();
      const res = await fetchWithTimeout(`${SERVER_URL}/api/institutes/${c}/tests/${test.id}/scores`, {}, 8000);
      if (res.ok) {
        const data = await res.json();
        const grades = {};
        const remarks = {};
        if (Array.isArray(data.scores)) {
          data.scores.forEach((s) => {
            grades[s.student_id] = s.marks_obtained.toString();
            if (s.remarks) remarks[s.student_id] = s.remarks;
          });
        }
        setTestGradesMap(grades);
        setTestRemarksMap(remarks);
      }
    } catch (e) {
      console.log('Error fetching test scores for grading:', e);
    }
  };

  // 8. Publish Scores & Notify Parents
  const handlePublishTestScores = async () => {
    if (!selectedTestForGrading) return;

    const scoresList = [];
    allStudents.forEach((student) => {
      const markStr = testGradesMap[student.student_id];
      if (markStr !== undefined && markStr !== '') {
        scoresList.push({
          student_id: student.student_id,
          marks_obtained: parseInt(markStr, 10) || 0,
          remarks: testRemarksMap[student.student_id] || undefined,
        });
      }
    });

    if (scoresList.length === 0) {
      Alert.alert('No Marks Entered', 'Please enter marks for at least one student.');
      return;
    }

    setTestSubmitting(true);
    try {
      const c = instituteCode.trim().toLowerCase();
      const res = await fetchWithTimeout(
        `${SERVER_URL}/api/institutes/${c}/tests/${selectedTestForGrading.id}/scores`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scores: scoresList }),
        },
        12000
      );

      if (!res.ok) throw new Error('Failed to publish scores.');
      const data = await res.json();
      Alert.alert(
        'Results Published!',
        `Saved scores for ${data.saved_scores} students and sent push notifications to ${data.notified_parents} parents!`
      );
      setSelectedTestForGrading(null);
      fetchTeacherTests(c);
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to submit test scores.');
    } finally {
      setTestSubmitting(false);
    }
  };

  // --- RENDER HELPERS ---
  const todayLatest = (() => {
    if (!attendanceLogs || attendanceLogs.length === 0) return null;
    const latest = attendanceLogs[0];
    const punchDate = new Date(latest.punch_time);
    const today = new Date();
    if (
      punchDate.getDate() === today.getDate() &&
      punchDate.getMonth() === today.getMonth() &&
      punchDate.getFullYear() === today.getFullYear()
    ) {
      return latest;
    }
    return null;
  })();

  const getDateHeader = (item, index) => {
    if (!item?.punch_time) return null;
    const d = new Date(item.punch_time);
    if (isNaN(d.getTime())) return null;

    const prevItem = index > 0 ? attendanceLogs[index - 1] : null;
    const prevD = prevItem?.punch_time ? new Date(prevItem.punch_time) : null;
    const currentKey = d.toDateString();
    const prevKey = prevD ? prevD.toDateString() : null;

    if (currentKey === prevKey) return null;

    const todayStr = new Date().toDateString();
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStr = yesterdayDate.toDateString();

    let title = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (currentKey === todayStr) title = 'Today • ' + title;
    else if (currentKey === yesterdayStr) title = 'Yesterday • ' + title;

    return (
      <View style={styles.dateHeaderContainer}>
        <CalendarBadgeIcon size={14} color="#4338CA" />
        <Text style={styles.dateHeaderText}>{title}</Text>
      </View>
    );
  };

  const renderAttendanceItem = ({ item, index }) => {
    if (!item) return null;
    const isEntry = item.punch_type === 'ENTRY';
    let timeStr = '--:--';
    try {
      if (item.punch_time) {
        const dateObj = new Date(item.punch_time);
        if (!isNaN(dateObj.getTime())) {
          timeStr = dateObj.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        }
      }
    } catch (e) {}

    return (
      <View>
        {getDateHeader(item, index)}
        <View style={[styles.logCard, item.is_early_exit && styles.earlyExitCard]}>
          <PunchDirectionIcon isEntry={isEntry} size={22} />
          <View style={styles.logInfo}>
            <View style={styles.logRow}>
              <Text style={styles.logTime}>{timeStr}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {item.is_early_exit && (
                  <View style={styles.badgeEarlyExit}>
                    <Text style={styles.badgeTextEarlyExit}>🚨 EARLY EXIT</Text>
                  </View>
                )}
                <View style={[styles.badge, isEntry ? styles.badgeEntry : styles.badgeExit]}>
                  <Text style={[styles.badgeText, isEntry ? styles.badgeTextEntry : styles.badgeTextExit]}>
                    {item.punch_type}
                  </Text>
                </View>
              </View>
            </View>

            {item.is_early_exit && item.reason && (
              <View style={styles.earlyReasonBox}>
                <Text style={styles.earlyReasonLabel}>Reason: </Text>
                <Text style={styles.earlyReasonText}>{item.reason}</Text>
              </View>
            )}

            <View style={styles.logSubRow}>
              <ScannerTargetIcon size={12} color="#64748B" />
              <Text style={styles.deviceLabel}>{item.device_name || 'Biometric Gate'}</Text>
            </View>
          </View>
        </View>
      </View>
    );
  };

  if (isRestoringSession) {
    return (
      <SafeAreaView style={[styles.safeArea, { justifyContent: 'center', alignItems: 'center', backgroundColor: '#312E81' }]}>
        <StatusBar barStyle="light-content" backgroundColor="#312E81" translucent={false} />
        <ActivityIndicator size="large" color="#FFFFFF" />
        <Text style={{ marginTop: 14, color: '#E0E7FF', fontSize: 15, fontWeight: '600' }}>
          Restoring Attendance Session...
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#4338CA" translucent={false} />

      {!isLoggedIn ? (
        /* ================= 1. CLEAN UNIFIED LOGIN SCREEN ================= */
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
          <View style={styles.loginWrapper}>
            <View style={styles.heroSection}>
              <View style={styles.logoCircle}>
                <AcademyEmblem size={44} color="#FFFFFF" />
              </View>
              <Text style={styles.heroTitle}>Student Attendance Tracker</Text>
              <TouchableOpacity onPress={() => Linking.openURL('https://www.tiastech.in')} activeOpacity={0.8}>
                <Text style={styles.heroSubtitle}>
                  Designed and Developed by <Text style={{ fontWeight: '800', textDecorationLine: 'underline', color: '#FFFFFF' }}>TIAS</Text>
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.loginCard}>
              <Text style={styles.cardHeader}>Institute Portal Login</Text>
              <Text style={styles.cardSubHeader}>Sign in as Teacher or Parent</Text>

              {/* Institute Code Input */}
              <View style={[styles.inputContainer, { marginTop: 16 }]}>
                <Text style={styles.fieldLabel}>INSTITUTE CODE</Text>
                <TextInput
                  style={[styles.textInputFull, { textTransform: 'lowercase', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }]}
                  placeholder="e.g. prepx, apex"
                  placeholderTextColor="#94A3B8"
                  autoCapitalize="none"
                  value={instituteCode}
                  onChangeText={setInstituteCode}
                />
              </View>

              {/* Mobile Number Input */}
              <View style={styles.inputContainer}>
                <Text style={styles.fieldLabel}>MOBILE NUMBER</Text>
                <View style={styles.phoneInputRow}>
                  <View style={styles.countryPill}>
                    <Text style={styles.countryPillText}>+91</Text>
                  </View>
                  <TextInput
                    style={styles.textInput}
                    placeholder="9876543210"
                    placeholderTextColor="#94A3B8"
                    keyboardType="phone-pad"
                    maxLength={10}
                    value={phone}
                    onChangeText={setPhone}
                  />
                </View>
              </View>

              <TouchableOpacity
                style={styles.signInButton}
                onPress={handleLogin}
                disabled={loading}
                activeOpacity={0.85}
              >
                {loading ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.signInButtonText}>Enter Institute Portal</Text>
                )}
              </TouchableOpacity>

              {/* Clean Single Privacy Policy Link */}
              <TouchableOpacity
                style={styles.privacyLinkContainer}
                onPress={() => Linking.openURL(`${SERVER_URL}/privacy-policy`)}
                activeOpacity={0.7}
              >
                <Text style={styles.privacyLinkText}>Privacy Policy</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      ) : (
        /* ================= 2. AUTHENTICATED PORTALS ================= */
        <View style={styles.dashboardWrapper}>
          {/* TOP HEADER */}
          <View style={styles.dashboardHeader}>
            <View style={styles.headerLeft}>
              <View style={styles.avatarCircle}>
                <Text style={styles.avatarInitial}>
                  {activeRole === 'teacher'
                    ? (teacherData?.name ? teacherData.name.charAt(0).toUpperCase() : 'T')
                    : (selectedStudent?.name ? selectedStudent.name.charAt(0).toUpperCase() : 'S')}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.headerStudentName} numberOfLines={1}>
                  {activeRole === 'teacher'
                    ? (teacherData?.name || 'Faculty Member')
                    : (selectedStudent?.name || 'Student')}
                </Text>
                <Text style={styles.headerGradeText}>
                  {instituteMeta?.name || instituteCode.toUpperCase()} • {activeRole === 'teacher' ? (teacherData?.subject || 'Teacher') : `ID: #${selectedStudent?.student_id || ''}`}
                </Text>
              </View>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {/* Sound Test */}
              <TouchableOpacity onPress={handleTestSound} style={styles.soundBtn} activeOpacity={0.75}>
                <ChimeIcon size={16} color="#FFFFFF" />
              </TouchableOpacity>

              {/* Logout */}
              <TouchableOpacity onPress={handleLogout} style={styles.logoutBtn} activeOpacity={0.75}>
                <ExitDoorIcon size={14} color="#FFFFFF" />
                <Text style={styles.logoutBtnText}>Logout</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* DUAL-ROLE SWITCHER PILL (If user is both Teacher and Parent) */}
          {roles.length > 1 && (
            <View style={styles.roleSwitcherBar}>
              <TouchableOpacity
                style={[styles.roleSwitchBtn, activeRole === 'teacher' && styles.roleSwitchBtnActive]}
                onPress={() => switchRole('teacher')}
              >
                <Text style={[styles.roleSwitchText, activeRole === 'teacher' && styles.roleSwitchTextActive]}>
                  👨‍🏫 Teacher Mode
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.roleSwitchBtn, activeRole === 'parent' && styles.roleSwitchBtnActive]}
                onPress={() => switchRole('parent')}
              >
                <Text style={[styles.roleSwitchText, activeRole === 'parent' && styles.roleSwitchTextActive]}>
                  👨‍👩‍👧 Parent Mode
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* ============================================================ */}
          {/* ==================== A. PARENT PORTAL ==================== */}
          {/* ============================================================ */}
          {activeRole === 'parent' && (
            <View style={{ flex: 1 }}>
              {/* Student selector tabs if multiple children enrolled */}
              {students.length > 1 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll}>
                  {students.map((s) => (
                    <TouchableOpacity
                      key={s.student_id}
                      style={[styles.tabItem, selectedStudent?.student_id === s.student_id && styles.activeTabItem]}
                      onPress={() => {
                        setSelectedStudent(s);
                        loadStudentData(s.student_id, instituteCode);
                      }}
                    >
                      <Text style={[styles.tabText, selectedStudent?.student_id === s.student_id && styles.activeTabText]}>
                        {s.name}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}

              {/* Feature Navigation Tabs */}
              <View style={styles.featureTabBar}>
                <TouchableOpacity
                  style={[styles.featureTabItem, parentTab === 'attendance' && styles.featureTabItemActive]}
                  onPress={() => setParentTab('attendance')}
                >
                  <Text style={[styles.featureTabText, parentTab === 'attendance' && styles.featureTabTextActive]}>
                    Attendance
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.featureTabItem, parentTab === 'announcements' && styles.featureTabItemActive]}
                  onPress={() => setParentTab('announcements')}
                >
                  <Text style={[styles.featureTabText, parentTab === 'announcements' && styles.featureTabTextActive]}>
                    Notices ({announcements.length})
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.featureTabItem, parentTab === 'timetable' && styles.featureTabItemActive]}
                  onPress={() => setParentTab('timetable')}
                >
                  <Text style={[styles.featureTabText, parentTab === 'timetable' && styles.featureTabTextActive]}>
                    Timetable
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.featureTabItem, parentTab === 'tests' && styles.featureTabItemActive]}
                  onPress={() => setParentTab('tests')}
                >
                  <Text style={[styles.featureTabText, parentTab === 'tests' && styles.featureTabTextActive]}>
                    Tests & Track
                  </Text>
                </TouchableOpacity>
              </View>

              {/* TAB 1: ATTENDANCE PUNCHES */}
              {parentTab === 'attendance' && (
                <View style={{ flex: 1 }}>
                  {/* Live sync & refresh */}
                  <View style={styles.liveStatusBar}>
                    <View style={styles.liveIndicatorRow}>
                      <View style={styles.livePulseDot} />
                      <Text style={styles.liveIndicatorText}>LIVE BIOMETRIC SYNC</Text>
                    </View>
                    <TouchableOpacity style={styles.refreshBtn} onPress={onRefresh} disabled={refreshing}>
                      {refreshing ? (
                        <ActivityIndicator size="small" color="#4F46E5" style={{ marginRight: 4 }} />
                      ) : (
                        <SyncCycleIcon size={12} color="#4F46E5" />
                      )}
                      <Text style={styles.refreshBtnText}>{refreshing ? 'Syncing...' : 'Refresh'}</Text>
                    </TouchableOpacity>
                  </View>

                  {/* Today's Status Card */}
                  <View style={styles.todayCard}>
                    <View style={styles.todayCardContent}>
                      <Text style={styles.todayCardLabel}>TODAY'S STATUS</Text>
                      <View style={styles.todayStatusRow}>
                        <View
                          style={[
                            styles.statusDot,
                            todayLatest
                              ? todayLatest.punch_type === 'ENTRY'
                                ? styles.dotGreen
                                : styles.dotRed
                              : styles.dotGray,
                          ]}
                        />
                        <Text style={styles.todayStatusText}>
                          {todayLatest
                            ? todayLatest.is_early_exit
                              ? 'Left Early'
                              : (todayLatest.punch_type === 'ENTRY' ? 'Currently IN' : 'Checked OUT')
                            : 'No Activity Today'}
                        </Text>
                      </View>
                      <Text style={styles.todaySubText}>
                        {todayLatest
                          ? `Last punch at ${new Date(todayLatest.punch_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • ${todayLatest.device_name || 'Biometric Gate'}`
                          : 'Waiting for biometric scanner event'}
                      </Text>
                    </View>
                    <View style={styles.todayBadge}>
                      <StatusCrest status={todayLatest ? todayLatest.punch_type : 'NONE'} size={40} />
                    </View>
                  </View>

                  {/* Attendance Log List */}
                  <FlatList
                    data={attendanceLogs}
                    keyExtractor={(item) => item.id.toString()}
                    renderItem={renderAttendanceItem}
                    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#4F46E5']} />}
                    contentContainerStyle={styles.listContent}
                    ListEmptyComponent={
                      <View style={styles.emptyState}>
                        <EmptyAttendanceGraphic size={56} />
                        <Text style={styles.emptyTitle}>No Attendance Records Found</Text>
                        <Text style={styles.emptyDesc}>Logs will appear here instantly when {selectedStudent?.name} punches at the center.</Text>
                      </View>
                    }
                  />
                </View>
              )}

              {/* TAB 2: ANNOUNCEMENTS & HOLIDAYS */}
              {parentTab === 'announcements' && (
                <FlatList
                  data={announcements}
                  keyExtractor={(item) => item.id.toString()}
                  refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#4F46E5']} />}
                  contentContainerStyle={styles.listContent}
                  ListHeaderComponent={
                    <View style={styles.subHeaderBox}>
                      <Text style={styles.subHeaderTitle}>📢 Institute Notice Board</Text>
                      <Text style={styles.subHeaderDesc}>Official notifications for holidays, class reschedules, and academic notices.</Text>
                    </View>
                  }
                  renderItem={({ item }) => {
                    const isHoliday = item.category === 'HOLIDAY';
                    const isReschedule = item.category === 'CLASS_CHANGE';
                    const isExam = item.category === 'EXAM';
                    return (
                      <View style={[styles.announcementCard, isHoliday && styles.annCardHoliday, isReschedule && styles.annCardReschedule]}>
                        <View style={styles.annTopRow}>
                          <View style={[
                            styles.categoryPill,
                            isHoliday && styles.pillHoliday,
                            isReschedule && styles.pillReschedule,
                            isExam && styles.pillExam,
                          ]}>
                            <Text style={styles.categoryPillText}>
                              {isHoliday ? '🎉 HOLIDAY' : isReschedule ? '⏰ CLASS RESCHEDULE' : isExam ? '📝 EXAM NOTICE' : '📢 NOTICE'}
                            </Text>
                          </View>
                          {item.effective_date && (
                            <View style={styles.datePill}>
                              <Text style={styles.datePillText}>📅 {item.effective_date}</Text>
                            </View>
                          )}
                        </View>
                        <Text style={styles.annTitle}>{item.title}</Text>
                        <Text style={styles.annDesc}>{item.description}</Text>
                        <Text style={styles.annMeta}>Posted by {item.created_by || 'Institute'} • Batch: {item.batch_grade || 'All'}</Text>
                      </View>
                    );
                  }}
                  ListEmptyComponent={
                    <View style={styles.emptyState}>
                      <Text style={styles.emptyIcon}>📢</Text>
                      <Text style={styles.emptyTitle}>No Announcements</Text>
                      <Text style={styles.emptyDesc}>No active notices or holiday announcements at this time.</Text>
                    </View>
                  }
                />
              )}

              {/* TAB 3: WEEKLY TIMETABLE */}
              {parentTab === 'timetable' && (
                <View style={{ flex: 1 }}>
                  {/* Day Selector Pills */}
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.daySelectorScroll}>
                    {DAYS_OF_WEEK.map((d) => (
                      <TouchableOpacity
                        key={d}
                        style={[styles.dayPill, selectedTimetableDay === d && styles.dayPillActive]}
                        onPress={() => setSelectedTimetableDay(d)}
                      >
                        <Text style={[styles.dayPillText, selectedTimetableDay === d && styles.dayPillTextActive]}>
                          {d.slice(0, 3)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>

                  <FlatList
                    data={timetableSlots.filter((s) => s.day.toLowerCase() === selectedTimetableDay.toLowerCase())}
                    keyExtractor={(item) => item.id.toString()}
                    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#4F46E5']} />}
                    contentContainerStyle={styles.listContent}
                    ListHeaderComponent={
                      <View style={styles.subHeaderBox}>
                        <Text style={styles.subHeaderTitle}>🗓 {selectedTimetableDay} Class Schedule</Text>
                        <Text style={styles.subHeaderDesc}>Routine for {selectedStudent?.institute_name || 'Institute'}</Text>
                      </View>
                    }
                    renderItem={({ item }) => (
                      <View style={styles.timetableCard}>
                        <View style={styles.timeBadge}>
                          <Text style={styles.timeBadgeText}>{item.time_slot}</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.ttSubjectText}>{item.subject}</Text>
                          <View style={styles.ttMetaRow}>
                            {item.teacher && <Text style={styles.ttMetaText}>👨‍🏫 {item.teacher}</Text>}
                            {item.room && <Text style={styles.ttMetaText}>🚪 {item.room}</Text>}
                            {item.grade && <Text style={styles.ttMetaText}>👥 {item.grade}</Text>}
                          </View>
                        </View>
                      </View>
                    )}
                    ListEmptyComponent={
                      <View style={styles.emptyState}>
                        <Text style={styles.emptyIcon}>🏖</Text>
                        <Text style={styles.emptyTitle}>No Classes on {selectedTimetableDay}</Text>
                        <Text style={styles.emptyDesc}>Enjoy your study break or revision time.</Text>
                      </View>
                    }
                  />
                </View>
              )}

              {/* TAB 4: TEST RESULTS & CUMULATIVE TRACKING */}
              {parentTab === 'tests' && (
                <ScrollView
                  contentContainerStyle={styles.listContent}
                  refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#4F46E5']} />}
                >
                  {cumulativeTests ? (
                    <View>
                      {/* CUMULATIVE SUMMARY CARD */}
                      <View style={styles.cumulativeHeaderCard}>
                        <Text style={styles.cumulativeCardTitle}>📈 Cumulative Performance Tracking</Text>
                        <Text style={styles.cumulativeCardSub}>
                          Tracking test-by-test academic progression for {cumulativeTests.student_name}
                        </Text>

                        {/* Stat Badges */}
                        <View style={styles.statGrid}>
                          <View style={styles.statBox}>
                            <Text style={styles.statValue}>
                              {cumulativeTests.overall_improvement > 0 ? `+${cumulativeTests.overall_improvement}%` : `${cumulativeTests.overall_improvement}%`}
                            </Text>
                            <Text style={styles.statLabel}>Growth (T1 ➔ Latest)</Text>
                          </View>
                          <View style={styles.statBox}>
                            <Text style={styles.statValue}>{cumulativeTests.average_percentage}%</Text>
                            <Text style={styles.statLabel}>Average Score</Text>
                          </View>
                          <View style={styles.statBox}>
                            <Text style={styles.statValue}>{cumulativeTests.highest_percentage}%</Text>
                            <Text style={styles.statLabel}>Best Score</Text>
                          </View>
                          <View style={styles.statBox}>
                            <Text style={styles.statValue}>{cumulativeTests.total_tests}</Text>
                            <Text style={styles.statLabel}>Tests Taken</Text>
                          </View>
                        </View>

                        {/* Progression Stepper */}
                        {Array.isArray(cumulativeTests.timeline) && cumulativeTests.timeline.length > 1 && (
                          <View style={styles.stepperContainer}>
                            <Text style={styles.stepperTitle}>Progression Timeline</Text>
                            <View style={styles.stepperRow}>
                              {cumulativeTests.timeline.map((item, idx) => (
                                <View key={item.test_id} style={styles.stepItem}>
                                  <View style={[styles.stepCircle, idx === cumulativeTests.timeline.length - 1 && styles.stepCircleActive]}>
                                    <Text style={styles.stepCircleText}>{item.percentage}%</Text>
                                  </View>
                                  <Text style={styles.stepLabel} numberOfLines={1}>T{item.test_index}</Text>
                                  {idx > 0 && (
                                    <View style={styles.stepDeltaBadge}>
                                      <Text style={styles.stepDeltaText}>
                                        {item.delta_from_previous >= 0 ? `+${item.delta_from_previous}%` : `${item.delta_from_previous}%`}
                                      </Text>
                                    </View>
                                  )}
                                </View>
                              ))}
                            </View>
                          </View>
                        )}
                      </View>

                      {/* INDIVIDUAL TEST SCORE CARDS */}
                      <Text style={[styles.sectionHeading, { marginTop: 18, marginBottom: 8 }]}>
                        Test History & Teacher Remarks
                      </Text>

                      {cumulativeTests.timeline?.map((test) => (
                        <View key={test.test_id} style={styles.testScoreCard}>
                          <View style={styles.testCardTop}>
                            <View style={{ flex: 1 }}>
                              <Text style={styles.testNameText}>{test.test_name}</Text>
                              <Text style={styles.testSubjectText}>{test.subject} • {test.test_date || 'Recent'}</Text>
                            </View>
                            <View style={styles.scorePill}>
                              <Text style={styles.scorePillMain}>{test.marks_obtained}/{test.max_marks}</Text>
                              <Text style={styles.scorePillPct}>{test.percentage}%</Text>
                            </View>
                          </View>

                          {test.delta_from_previous !== 0 && (
                            <View style={styles.testDeltaRow}>
                              <Text style={[styles.testDeltaLabel, test.delta_from_previous > 0 ? styles.deltaUp : styles.deltaDown]}>
                                {test.delta_from_previous > 0 ? `▲ Improved by +${test.delta_from_previous}% from previous test` : `▼ Dropped by ${test.delta_from_previous}% from previous test`}
                              </Text>
                            </View>
                          )}

                          {test.remarks && (
                            <View style={styles.remarksBox}>
                              <Text style={styles.remarksLabel}>Teacher Note: </Text>
                              <Text style={styles.remarksText}>{test.remarks}</Text>
                            </View>
                          )}
                        </View>
                      ))}
                    </View>
                  ) : (
                    <View style={styles.emptyState}>
                      <Text style={styles.emptyIcon}>📝</Text>
                      <Text style={styles.emptyTitle}>No Test Records</Text>
                      <Text style={styles.emptyDesc}>Published test results and cumulative growth tracking will appear here.</Text>
                    </View>
                  )}
                </ScrollView>
              )}
            </View>
          )}

          {/* ============================================================ */}
          {/* ==================== B. TEACHER PORTAL =================== */}
          {/* ============================================================ */}
          {activeRole === 'teacher' && (
            <View style={{ flex: 1 }}>
              {/* Feature Navigation Tabs for Teacher */}
              <View style={styles.featureTabBar}>
                <TouchableOpacity
                  style={[styles.featureTabItem, teacherTab === 'early_out' && styles.featureTabItemActive]}
                  onPress={() => setTeacherTab('early_out')}
                >
                  <Text style={[styles.featureTabText, teacherTab === 'early_out' && styles.featureTabTextActive]}>
                    Early Exit
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.featureTabItem, teacherTab === 'notices' && styles.featureTabItemActive]}
                  onPress={() => setTeacherTab('notices')}
                >
                  <Text style={[styles.featureTabText, teacherTab === 'notices' && styles.featureTabTextActive]}>
                    Declare Notice
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.featureTabItem, teacherTab === 'timetable_mgmt' && styles.featureTabItemActive]}
                  onPress={() => setTeacherTab('timetable_mgmt')}
                >
                  <Text style={[styles.featureTabText, teacherTab === 'timetable_mgmt' && styles.featureTabTextActive]}>
                    Timetable
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.featureTabItem, teacherTab === 'tests_mgmt' && styles.featureTabItemActive]}
                  onPress={() => setTeacherTab('tests_mgmt')}
                >
                  <Text style={[styles.featureTabText, teacherTab === 'tests_mgmt' && styles.featureTabTextActive]}>
                    Grade Tests
                  </Text>
                </TouchableOpacity>
              </View>

              {/* TEACHER TAB 1: EARLY OUT LOGGING */}
              {teacherTab === 'early_out' && (
                <ScrollView contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
                  <View style={styles.formCard}>
                    <Text style={styles.formCardTitle}>🚨 Log Student Early Departure</Text>
                    <Text style={styles.formCardDesc}>
                      Records an early exit punch in the database and immediately delivers a high-priority push notification to the parent's phone.
                    </Text>

                    {/* Student Selector */}
                    <Text style={styles.formLabel}>SELECT STUDENT</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
                      {allStudents.map((s) => (
                        <TouchableOpacity
                          key={s.student_id}
                          style={[styles.studentPill, earlyOutStudentId === s.student_id && styles.studentPillActive]}
                          onPress={() => setEarlyOutStudentId(s.student_id)}
                        >
                          <Text style={[styles.studentPillText, earlyOutStudentId === s.student_id && styles.studentPillTextActive]}>
                            #{s.student_id} {s.name}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>

                    {/* Common Reason Quick Chips */}
                    <Text style={styles.formLabel}>SELECT REASON</Text>
                    <View style={styles.chipRow}>
                      {['Medical / Sick', 'Family Emergency', 'Doctor Appointment', 'Special Permission'].map((r) => (
                        <TouchableOpacity
                          key={r}
                          style={[styles.reasonChip, earlyOutReason === r && styles.reasonChipActive]}
                          onPress={() => setEarlyOutReason(r)}
                        >
                          <Text style={[styles.reasonChipText, earlyOutReason === r && styles.reasonChipTextActive]}>
                            {r}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>

                    {/* Custom Reason Input */}
                    <Text style={[styles.formLabel, { marginTop: 12 }]}>OR CUSTOM REASON</Text>
                    <TextInput
                      style={styles.textInputFull}
                      placeholder="e.g. Unwell, Fever, Prior Permission"
                      value={earlyOutReason}
                      onChangeText={setEarlyOutReason}
                    />

                    {/* Additional Notes */}
                    <Text style={[styles.formLabel, { marginTop: 12 }]}>INTERNAL NOTES (OPTIONAL)</Text>
                    <TextInput
                      style={[styles.textInputFull, { height: 70, textAlignVertical: 'top' }]}
                      placeholder="e.g. Left with father Mr. Das after verification"
                      multiline
                      value={earlyOutNotes}
                      onChangeText={setEarlyOutNotes}
                    />

                    <TouchableOpacity
                      style={styles.submitActionBtn}
                      onPress={handleEarlyOutSubmit}
                      disabled={earlyOutSubmitting}
                    >
                      {earlyOutSubmitting ? (
                        <ActivityIndicator color="#FFFFFF" />
                      ) : (
                        <Text style={styles.submitActionBtnText}>Log Early Exit & Alert Parent</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                </ScrollView>
              )}

              {/* TEACHER TAB 2: DECLARE HOLIDAY / CLASS RESCHEDULE */}
              {teacherTab === 'notices' && (
                <ScrollView contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
                  <View style={styles.formCard}>
                    <Text style={styles.formCardTitle}>📢 Broadcast Notice or Holiday</Text>
                    <Text style={styles.formCardDesc}>
                      Posts to the parent notice board and sends a push notification to every registered parent.
                    </Text>

                    {/* Category Selector */}
                    <Text style={styles.formLabel}>CATEGORY</Text>
                    <View style={styles.chipRow}>
                      {[
                        { key: 'HOLIDAY', label: '🎉 Holiday' },
                        { key: 'CLASS_CHANGE', label: '⏰ Reschedule' },
                        { key: 'EXAM', label: '📝 Exam' },
                        { key: 'GENERAL', label: '📢 Notice' },
                      ].map((c) => (
                        <TouchableOpacity
                          key={c.key}
                          style={[styles.reasonChip, annCategory === c.key && styles.reasonChipActive]}
                          onPress={() => setAnnCategory(c.key)}
                        >
                          <Text style={[styles.reasonChipText, annCategory === c.key && styles.reasonChipTextActive]}>
                            {c.label}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>

                    <Text style={[styles.formLabel, { marginTop: 12 }]}>NOTICE TITLE</Text>
                    <TextInput
                      style={styles.textInputFull}
                      placeholder="e.g. Holiday on Guru Nanak Jayanti"
                      value={annTitle}
                      onChangeText={setAnnTitle}
                    />

                    <Text style={[styles.formLabel, { marginTop: 12 }]}>EFFECTIVE DATE / TIME</Text>
                    <TextInput
                      style={styles.textInputFull}
                      placeholder="e.g. Friday 28 Nov or Tomorrow 5 PM"
                      value={annDate}
                      onChangeText={setAnnDate}
                    />

                    <Text style={[styles.formLabel, { marginTop: 12 }]}>DESCRIPTION / DETAILS</Text>
                    <TextInput
                      style={[styles.textInputFull, { height: 90, textAlignVertical: 'top' }]}
                      placeholder="Provide complete details for parents..."
                      multiline
                      value={annDesc}
                      onChangeText={setAnnDesc}
                    />

                    <TouchableOpacity
                      style={styles.submitActionBtn}
                      onPress={handleAnnouncementSubmit}
                      disabled={annSubmitting}
                    >
                      {annSubmitting ? (
                        <ActivityIndicator color="#FFFFFF" />
                      ) : (
                        <Text style={styles.submitActionBtnText}>Broadcast Notice to All Parents</Text>
                      )}
                    </TouchableOpacity>
                  </View>

                  {/* Active Announcements List with Delete */}
                  <Text style={[styles.sectionHeading, { marginTop: 20, marginBottom: 8 }]}>Active Notices</Text>
                  {announcements.map((item) => (
                    <View key={item.id} style={styles.announcementCard}>
                      <View style={styles.annTopRow}>
                        <View style={styles.categoryPill}>
                          <Text style={styles.categoryPillText}>{item.category}</Text>
                        </View>
                        <TouchableOpacity onPress={() => handleDeleteAnnouncement(item.id)}>
                          <Text style={{ color: '#EF4444', fontWeight: '700', fontSize: 12 }}>Delete</Text>
                        </TouchableOpacity>
                      </View>
                      <Text style={styles.annTitle}>{item.title}</Text>
                      <Text style={styles.annDesc}>{item.description}</Text>
                      {item.effective_date && <Text style={styles.annMeta}>Effective: {item.effective_date}</Text>}
                    </View>
                  ))}
                </ScrollView>
              )}

              {/* TEACHER TAB 3: TIMETABLE MANAGEMENT */}
              {teacherTab === 'timetable_mgmt' && (
                <ScrollView contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
                  <View style={styles.formCard}>
                    <Text style={styles.formCardTitle}>🗓 Add Weekly Timetable Slot</Text>

                    <Text style={styles.formLabel}>DAY</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
                      {DAYS_OF_WEEK.map((d) => (
                        <TouchableOpacity
                          key={d}
                          style={[styles.dayPill, ttDay === d && styles.dayPillActive]}
                          onPress={() => setTtDay(d)}
                        >
                          <Text style={[styles.dayPillText, ttDay === d && styles.dayPillTextActive]}>{d}</Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>

                    <Text style={styles.formLabel}>SUBJECT</Text>
                    <TextInput
                      style={styles.textInputFull}
                      placeholder="e.g. Chemistry - Organic"
                      value={ttSubject}
                      onChangeText={setTtSubject}
                    />

                    <Text style={[styles.formLabel, { marginTop: 12 }]}>TIME SLOT</Text>
                    <TextInput
                      style={styles.textInputFull}
                      placeholder="e.g. 04:00 PM - 05:30 PM"
                      value={ttTimeSlot}
                      onChangeText={setTtTimeSlot}
                    />

                    <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.formLabel}>FACULTY NAME</Text>
                        <TextInput
                          style={styles.textInputFull}
                          placeholder="e.g. Arup Sir"
                          value={ttTeacher}
                          onChangeText={setTtTeacher}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.formLabel}>ROOM</Text>
                        <TextInput
                          style={styles.textInputFull}
                          placeholder="e.g. Room 1"
                          value={ttRoom}
                          onChangeText={setTtRoom}
                        />
                      </View>
                    </View>

                    <TouchableOpacity
                      style={styles.submitActionBtn}
                      onPress={handleTimetableSubmit}
                      disabled={ttSubmitting}
                    >
                      {ttSubmitting ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.submitActionBtnText}>Add Slot to Schedule</Text>}
                    </TouchableOpacity>
                  </View>

                  {/* Scheduled Slots */}
                  <Text style={[styles.sectionHeading, { marginTop: 20, marginBottom: 8 }]}>Current Routine</Text>
                  {timetableSlots.map((slot) => (
                    <View key={slot.id} style={styles.timetableCard}>
                      <View style={styles.timeBadge}>
                        <Text style={styles.timeBadgeText}>{slot.day}</Text>
                        <Text style={[styles.timeBadgeText, { fontSize: 10, marginTop: 2 }]}>{slot.time_slot}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.ttSubjectText}>{slot.subject}</Text>
                        <Text style={styles.ttMetaText}>👨‍🏫 {slot.teacher || 'Faculty'} • 🚪 {slot.room || 'Room'}</Text>
                      </View>
                      <TouchableOpacity onPress={() => handleDeleteTimetableSlot(slot.id)}>
                        <Text style={{ color: '#EF4444', fontWeight: '700', fontSize: 12 }}>Delete</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </ScrollView>
              )}

              {/* TEACHER TAB 4: TESTS & GRADING */}
              {teacherTab === 'tests_mgmt' && (
                <ScrollView contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
                  {selectedTestForGrading ? (
                    /* GRADING MODAL VIEW */
                    <View style={styles.formCard}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Text style={styles.formCardTitle}>Grading: {selectedTestForGrading.name}</Text>
                        <TouchableOpacity onPress={() => setSelectedTestForGrading(null)}>
                          <Text style={{ color: '#4F46E5', fontWeight: '700' }}>Done</Text>
                        </TouchableOpacity>
                      </View>
                      <Text style={styles.formCardDesc}>
                        Subject: {selectedTestForGrading.subject} • Max Marks: {selectedTestForGrading.max_marks}
                      </Text>

                      {allStudents.map((st) => (
                        <View key={st.student_id} style={styles.studentGradeRow}>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.stGradeName}>#{st.student_id} {st.name}</Text>
                            <TextInput
                              style={[styles.textInputFull, { marginTop: 4, height: 38, fontSize: 13 }]}
                              placeholder="Remarks (e.g. Good improvement!)"
                              value={testRemarksMap[st.student_id] || ''}
                              onChangeText={(t) => setTestRemarksMap({ ...testRemarksMap, [st.student_id]: t })}
                            />
                          </View>
                          <View style={{ width: 80, marginLeft: 10 }}>
                            <TextInput
                              style={[styles.textInputFull, { textAlign: 'center', fontWeight: '800', height: 42 }]}
                              placeholder="Marks"
                              keyboardType="numeric"
                              maxLength={3}
                              value={testGradesMap[st.student_id] || ''}
                              onChangeText={(val) => setTestGradesMap({ ...testGradesMap, [st.student_id]: val })}
                            />
                          </View>
                        </View>
                      ))}

                      <TouchableOpacity
                        style={styles.submitActionBtn}
                        onPress={handlePublishTestScores}
                        disabled={testSubmitting}
                      >
                        {testSubmitting ? (
                          <ActivityIndicator color="#FFFFFF" />
                        ) : (
                          <Text style={styles.submitActionBtnText}>Publish & Push Notify Parents</Text>
                        )}
                      </TouchableOpacity>
                    </View>
                  ) : (
                    /* CREATE TEST & TEST LIST VIEW */
                    <View>
                      <View style={styles.formCard}>
                        <Text style={styles.formCardTitle}>📝 Create New Test</Text>
                        <Text style={styles.formCardDesc}>Define test details and enter student scores.</Text>

                        <Text style={styles.formLabel}>TEST TITLE</Text>
                        <TextInput
                          style={styles.textInputFull}
                          placeholder="e.g. Test 4 - Organic Reactions"
                          value={newTestName}
                          onChangeText={setNewTestName}
                        />

                        <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                          <View style={{ flex: 1.5 }}>
                            <Text style={styles.formLabel}>SUBJECT</Text>
                            <TextInput
                              style={styles.textInputFull}
                              placeholder="e.g. Chemistry"
                              value={newTestSubject}
                              onChangeText={setNewTestSubject}
                            />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.formLabel}>MAX MARKS</Text>
                            <TextInput
                              style={styles.textInputFull}
                              placeholder="100"
                              keyboardType="numeric"
                              value={newTestMaxMarks}
                              onChangeText={setNewTestMaxMarks}
                            />
                          </View>
                        </View>

                        <TouchableOpacity
                          style={styles.submitActionBtn}
                          onPress={handleCreateTest}
                          disabled={testSubmitting}
                        >
                          {testSubmitting ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.submitActionBtnText}>Create Test</Text>}
                        </TouchableOpacity>
                      </View>

                      {/* Test List */}
                      <Text style={[styles.sectionHeading, { marginTop: 20, marginBottom: 8 }]}>Tests & Cumulative History</Text>
                      {teacherTests.map((t) => (
                        <View key={t.id} style={styles.testScoreCard}>
                          <View style={styles.testCardTop}>
                            <View style={{ flex: 1 }}>
                              <Text style={styles.testNameText}>{t.name}</Text>
                              <Text style={styles.testSubjectText}>{t.subject} • Max: {t.max_marks}</Text>
                              <Text style={styles.ttMetaText}>
                                Graded: {t.graded_students_count} students {t.class_average_pct ? `• Average: ${t.class_average_pct}%` : ''}
                              </Text>
                            </View>
                            <TouchableOpacity
                              style={styles.gradeActionBtn}
                              onPress={() => handleSelectTestForGrading(t)}
                            >
                              <Text style={styles.gradeActionBtnText}>Grade Marks</Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                      ))}
                    </View>
                  )}
                </ScrollView>
              )}
            </View>
          )}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#4338CA',
  },
  loginWrapper: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  heroSection: {
    backgroundColor: '#4338CA',
    paddingTop: 32,
    paddingBottom: 48,
    paddingHorizontal: 24,
    alignItems: 'center',
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
  },
  logoCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  heroTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: -0.5,
  },
  heroSubtitle: {
    fontSize: 12,
    color: '#C7D2FE',
    marginTop: 6,
  },
  loginCard: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 20,
    marginTop: -24,
    borderRadius: 24,
    padding: 24,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
    marginBottom: 30,
  },
  cardHeader: {
    fontSize: 20,
    fontWeight: '800',
    color: '#1E293B',
  },
  cardSubHeader: {
    fontSize: 13,
    color: '#64748B',
    marginTop: 2,
    marginBottom: 8,
  },
  inputContainer: {
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#475569',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  textInputFull: {
    borderWidth: 1.5,
    borderColor: '#E2E8F0',
    borderRadius: 14,
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    fontWeight: '600',
    color: '#0F172A',
  },
  phoneInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#E2E8F0',
    borderRadius: 14,
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 12,
  },
  countryPill: {
    backgroundColor: '#EEF2FF',
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#C7D2FE',
    marginRight: 8,
  },
  countryPillText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#4338CA',
  },
  textInput: {
    flex: 1,
    paddingVertical: 12,
    fontSize: 16,
    fontWeight: '600',
    color: '#0F172A',
  },
  signInButton: {
    backgroundColor: '#4F46E5',
    paddingVertical: 15,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 8,
    shadowColor: '#4F46E5',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 3,
  },
  signInButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  privacyLinkContainer: {
    marginTop: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  privacyLinkText: {
    fontSize: 13,
    color: '#64748B',
    fontWeight: '600',
    textDecorationLine: 'underline',
  },

  /* DASHBOARD */
  dashboardWrapper: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  dashboardHeader: {
    backgroundColor: '#4338CA',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'android' ? 44 : 24,
    paddingBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 10,
  },
  avatarCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#EEF2FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  avatarInitial: {
    fontSize: 18,
    fontWeight: '800',
    color: '#4338CA',
  },
  headerStudentName: {
    fontSize: 17,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  headerGradeText: {
    fontSize: 12,
    color: '#C7D2FE',
    marginTop: 2,
  },
  soundBtn: {
    backgroundColor: 'rgba(255,255,255,0.18)',
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoutBtn: {
    backgroundColor: 'rgba(255,255,255,0.18)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  logoutBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },

  /* ROLE SWITCHER */
  roleSwitcherBar: {
    backgroundColor: '#3730A3',
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  roleSwitchBtn: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  roleSwitchBtnActive: {
    backgroundColor: '#FFFFFF',
  },
  roleSwitchText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#C7D2FE',
  },
  roleSwitchTextActive: {
    color: '#3730A3',
    fontWeight: '800',
  },

  /* TABS */
  tabsScroll: {
    backgroundColor: '#312E81',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  tabItem: {
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.12)',
    marginRight: 8,
  },
  activeTabItem: {
    backgroundColor: '#FFFFFF',
  },
  tabText: {
    fontSize: 12,
    color: '#C7D2FE',
    fontWeight: '600',
  },
  activeTabText: {
    color: '#312E81',
    fontWeight: '700',
  },

  /* FEATURE TAB BAR */
  featureTabBar: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
    paddingHorizontal: 10,
  },
  featureTabItem: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  featureTabItemActive: {
    borderBottomColor: '#4F46E5',
  },
  featureTabText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
  },
  featureTabTextActive: {
    color: '#4F46E5',
    fontWeight: '800',
  },

  /* LIVE BAR */
  liveStatusBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginTop: 10,
    marginBottom: 4,
  },
  liveIndicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  livePulseDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10B981',
  },
  liveIndicatorText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.6,
  },
  refreshBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#EEF2FF',
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#C7D2FE',
  },
  refreshBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#4F46E5',
    marginLeft: 4,
  },

  /* TODAY STATUS CARD */
  todayCard: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 6,
    padding: 16,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    elevation: 2,
  },
  todayCardContent: {
    flex: 1,
    paddingRight: 10,
  },
  todayCardLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94A3B8',
    letterSpacing: 0.6,
  },
  todayStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotGreen: {
    backgroundColor: '#10B981',
  },
  dotRed: {
    backgroundColor: '#EF4444',
  },
  dotGray: {
    backgroundColor: '#94A3B8',
  },
  todayStatusText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0F172A',
  },
  todaySubText: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 3,
  },
  todayBadge: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* LIST CONTENT */
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 40,
    paddingTop: 8,
  },
  dateHeaderContainer: {
    backgroundColor: '#EEF2FF',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
    marginTop: 10,
    marginBottom: 6,
    alignSelf: 'flex-start',
  },
  dateHeaderText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#4338CA',
  },
  logCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  earlyExitCard: {
    borderColor: '#FCA5A5',
    backgroundColor: '#FFF7ED',
  },
  logInfo: {
    flex: 1,
    marginLeft: 12,
  },
  logRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  logTime: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0F172A',
  },
  badge: {
    paddingVertical: 3,
    paddingHorizontal: 7,
    borderRadius: 6,
  },
  badgeEntry: {
    backgroundColor: '#DCFCE7',
  },
  badgeExit: {
    backgroundColor: '#FEE2E2',
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '800',
  },
  badgeTextEntry: {
    color: '#166534',
  },
  badgeTextExit: {
    color: '#991B1B',
  },
  badgeEarlyExit: {
    backgroundColor: '#FEE2E2',
    paddingVertical: 3,
    paddingHorizontal: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#FCA5A5',
  },
  badgeTextEarlyExit: {
    color: '#DC2626',
    fontSize: 10,
    fontWeight: '800',
  },
  earlyReasonBox: {
    flexDirection: 'row',
    marginTop: 4,
    backgroundColor: '#FEF3C7',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  earlyReasonLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#92400E',
  },
  earlyReasonText: {
    fontSize: 11,
    color: '#92400E',
    fontWeight: '600',
    flex: 1,
  },
  logSubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 4,
  },
  deviceLabel: {
    fontSize: 11,
    color: '#94A3B8',
  },

  /* SUBHEADERS */
  subHeaderBox: {
    marginVertical: 10,
  },
  subHeaderTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1E293B',
  },
  subHeaderDesc: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
  },

  /* ANNOUNCEMENTS */
  announcementCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  annCardHoliday: {
    borderColor: '#A7F3D0',
    backgroundColor: '#F0FDF4',
  },
  annCardReschedule: {
    borderColor: '#FED7AA',
    backgroundColor: '#FFFBEB',
  },
  annTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  categoryPill: {
    backgroundColor: '#EEF2FF',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  pillHoliday: {
    backgroundColor: '#DCFCE7',
  },
  pillReschedule: {
    backgroundColor: '#FEF3C7',
  },
  pillExam: {
    backgroundColor: '#E0E7FF',
  },
  categoryPillText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#1E293B',
  },
  datePill: {
    backgroundColor: 'rgba(0,0,0,0.04)',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  datePillText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#475569',
  },
  annTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: 4,
  },
  annDesc: {
    fontSize: 13,
    color: '#334155',
    lineHeight: 18,
  },
  annMeta: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 8,
    fontWeight: '600',
  },

  /* TIMETABLE */
  daySelectorScroll: {
    backgroundColor: '#FFFFFF',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  dayPill: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: '#F1F5F9',
    marginRight: 6,
  },
  dayPillActive: {
    backgroundColor: '#4F46E5',
  },
  dayPillText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
  },
  dayPillTextActive: {
    color: '#FFFFFF',
  },
  timetableCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    gap: 12,
  },
  timeBadge: {
    backgroundColor: '#EEF2FF',
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#C7D2FE',
  },
  timeBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#4338CA',
  },
  ttSubjectText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0F172A',
  },
  ttMetaRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  ttMetaText: {
    fontSize: 12,
    color: '#64748B',
    fontWeight: '600',
  },

  /* CUMULATIVE TESTS */
  cumulativeHeaderCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  cumulativeCardTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1E293B',
  },
  cumulativeCardSub: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
    marginBottom: 12,
  },
  statGrid: {
    flexDirection: 'row',
    gap: 8,
  },
  statBox: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  statValue: {
    fontSize: 16,
    fontWeight: '800',
    color: '#4338CA',
  },
  statLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: '#64748B',
    marginTop: 2,
    textAlign: 'center',
  },
  stepperContainer: {
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
  },
  stepperTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
    marginBottom: 10,
  },
  stepperRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  stepItem: {
    alignItems: 'center',
  },
  stepCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#EEF2FF',
    borderWidth: 2,
    borderColor: '#C7D2FE',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepCircleActive: {
    backgroundColor: '#4338CA',
    borderColor: '#312E81',
  },
  stepCircleText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#4338CA',
  },
  stepLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#475569',
    marginTop: 4,
  },
  stepDeltaBadge: {
    backgroundColor: '#DCFCE7',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
    marginTop: 2,
  },
  stepDeltaText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#166534',
  },
  testScoreCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  testCardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  testNameText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0F172A',
  },
  testSubjectText: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
  },
  scorePill: {
    backgroundColor: '#EEF2FF',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#C7D2FE',
  },
  scorePillMain: {
    fontSize: 14,
    fontWeight: '800',
    color: '#4338CA',
  },
  scorePillPct: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6366F1',
  },
  testDeltaRow: {
    marginTop: 6,
  },
  testDeltaLabel: {
    fontSize: 11,
    fontWeight: '700',
  },
  deltaUp: {
    color: '#16A34A',
  },
  deltaDown: {
    color: '#DC2626',
  },
  remarksBox: {
    marginTop: 8,
    backgroundColor: '#F8FAFC',
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  remarksLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#475569',
  },
  remarksText: {
    fontSize: 12,
    color: '#334155',
    marginTop: 2,
  },

  /* TEACHER PORTAL FORMS */
  formCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginBottom: 12,
  },
  formCardTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0F172A',
  },
  formCardDesc: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
    marginBottom: 14,
    lineHeight: 16,
  },
  formLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#475569',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  studentPill: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: '#F1F5F9',
    marginRight: 6,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  studentPillActive: {
    backgroundColor: '#4F46E5',
    borderColor: '#4338CA',
  },
  studentPillText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
  },
  studentPillTextActive: {
    color: '#FFFFFF',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  reasonChip: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: '#F1F5F9',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  reasonChipActive: {
    backgroundColor: '#EEF2FF',
    borderColor: '#4F46E5',
  },
  reasonChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#475569',
  },
  reasonChipTextActive: {
    color: '#4F46E5',
    fontWeight: '700',
  },
  submitActionBtn: {
    backgroundColor: '#4F46E5',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 16,
  },
  submitActionBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  studentGradeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  stGradeName: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0F172A',
  },
  gradeActionBtn: {
    backgroundColor: '#EEF2FF',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#C7D2FE',
  },
  gradeActionBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#4F46E5',
  },

  /* EMPTY STATES */
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    paddingHorizontal: 20,
  },
  emptyIcon: {
    fontSize: 36,
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 4,
  },
  emptyDesc: {
    fontSize: 12,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 16,
  },
  sectionHeading: {
    fontSize: 15,
    fontWeight: '800',
    color: '#1E293B',
  },
});
