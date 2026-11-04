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

// Helper: fetch with timeout (default 10 seconds)
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

export default function App() {
  const [instituteCode, setInstituteCode] = useState('');
  const [phone, setPhone] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isRestoringSession, setIsRestoringSession] = useState(true);
  const [students, setStudents] = useState([]);
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [attendanceLogs, setAttendanceLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deviceToken, setDeviceToken] = useState(null);

  // Sync token to server whenever logged in and token is available
  const syncPushTokenToServer = useCallback(async (tokenToSync, instCode, parentPhone) => {
    if (!tokenToSync || !instCode || !parentPhone) return;
    try {
      const res = await fetch(`${SERVER_URL}/api/parents/register-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          institute_code: instCode.trim().toLowerCase(),
          parent_phone: parentPhone.trim(),
          expo_push_token: tokenToSync,
        }),
      });
      const data = await res.json();
      console.log('Push token synced to server:', data);
    } catch (e) {
      console.log('Push token sync error:', e);
    }
  }, []);

  // Restore persistent login session on app launch
  useEffect(() => {
    const restoreSession = async () => {
      try {
        const savedSession = await AsyncStorage.getItem('@parent_session');
        if (savedSession) {
          const { instituteCode: savedCode, phone: savedPhone, selectedStudentId } = JSON.parse(savedSession);
          if (savedCode && savedPhone) {
            setInstituteCode(savedCode);
            setPhone(savedPhone);

            const res = await fetchWithTimeout(
              `${SERVER_URL}/api/institutes/${savedCode.trim().toLowerCase()}/parents/${savedPhone.trim()}/students`,
              {},
              8000
            );
            if (res.ok) {
              const data = await res.json();
              if (Array.isArray(data) && data.length > 0) {
                setStudents(data);
                const matched = selectedStudentId
                  ? data.find((s) => s.student_id === selectedStudentId)
                  : data[0];
                const active = matched || data[0];
                setSelectedStudent(active);
                setIsLoggedIn(true);
                fetchAttendance(active.student_id, savedCode);
              }
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

  // Initialize push notifications
  useEffect(() => {
    registerForPushNotificationsAsync().then((token) => {
      if (token) {
        setDeviceToken(token);
      }
    });
  }, []);

  // Keep server updated with push token when session is active
  useEffect(() => {
    if (isLoggedIn && deviceToken && instituteCode && phone) {
      syncPushTokenToServer(deviceToken, instituteCode, phone);
    }
  }, [isLoggedIn, deviceToken, instituteCode, phone, syncPushTokenToServer]);

  // Poll for live biometric updates when app is open
  useEffect(() => {
    if (!isLoggedIn || !selectedStudent) return;

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

            // Pop OS system banner with loud chime & vibration
            try {
              const isEntry = latest.punch_type === 'ENTRY';
              Vibration.vibrate([0, 500, 200, 500]);
              await Notifications.scheduleNotificationAsync({
                content: {
                  title: isEntry ? 'Student Check-In Verified' : 'Student Check-Out Verified',
                  body: isEntry
                    ? `${selectedStudent.name} entered ${selectedStudent.institute_name || 'Center'}.`
                    : `${selectedStudent.name} has left the center.`,
                  sound: 'default',
                  channelId: 'attendance-alerts',
                  priority: Notifications.AndroidNotificationPriority.MAX,
                  vibrate: [0, 500, 250, 500],
                },
                trigger: null,
              });
            } catch (notifErr) {
              console.log('Notification trigger error:', notifErr);
            }
          }
        }
      } catch (err) {
        // silent polling error
      }
    }, 3000);

    return () => clearInterval(pollInterval);
  }, [isLoggedIn, selectedStudent, instituteCode]);

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
          bypassDnd: false,
        });
        await Notifications.setNotificationChannelAsync('default', {
          name: 'Attendance Notifications',
          importance: Notifications.AndroidImportance.MAX,
          sound: 'default',
          vibrationPattern: [0, 500, 250, 500],
          enableVibrate: true,
          showBadge: true,
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

        if (finalStatus !== 'granted') {
          console.warn('Push notification permission was not granted by user.');
          return null;
        }

        const projectId =
          Constants?.expoConfig?.extra?.eas?.projectId ??
          Constants?.easConfig?.projectId ??
          'd7b8e82d-8623-49d0-ad6c-41d6df76473f';

        try {
          const expoTokenData = await Notifications.getExpoPushTokenAsync({
            projectId: projectId,
          });
          token = expoTokenData?.data;
          console.log('Successfully acquired Expo Push Token:', token);
        } catch (pushErr) {
          console.error('Failed to get Expo push token with projectId:', pushErr);
          try {
            const fallbackToken = await Notifications.getExpoPushTokenAsync();
            token = fallbackToken?.data;
          } catch (fbErr) {
            console.error('Fallback token acquisition error:', fbErr);
          }
        }
      } catch (deviceErr) {
        console.error('Error during push registration:', deviceErr);
      }
    } else {
      console.log('Must use a physical device for push notifications');
    }

    return token;
  }

  // Handle Login with Institute Code + Mobile Number
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
        `${SERVER_URL}/api/institutes/${cleanCode}/parents/${cleanPhone}/students`,
        {},
        10000
      );

      if (!res.ok) {
        if (res.status === 404) {
          throw new Error(`Institute "${cleanCode.toUpperCase()}" not found, or phone "${cleanPhone}" is not enrolled.`);
        }
        throw new Error(`Server returned status ${res.status}`);
      }
      const data = await res.json();

      if (!data || data.length === 0) {
        Alert.alert(
          'Student Not Found',
          `No student found for phone number "${cleanPhone}" under Institute "${cleanCode.toUpperCase()}".`
        );
        setLoading(false);
        return;
      }

      setStudents(data);
      const student = data[0];
      setSelectedStudent(student);
      setIsLoggedIn(true);

      // Save persistent session
      await AsyncStorage.setItem(
        '@parent_session',
        JSON.stringify({
          instituteCode: cleanCode,
          phone: cleanPhone,
          selectedStudentId: student.student_id,
        })
      );

      // Register device token on server immediately if ready
      if (deviceToken) {
        syncPushTokenToServer(deviceToken, cleanCode, cleanPhone);
      }

      // Fetch attendance records
      fetchAttendance(student.student_id, cleanCode);
    } catch (err) {
      console.log('Login error:', err.name, err.message);
      Alert.alert('Login Failed', err.message || 'Cannot connect to server. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await AsyncStorage.removeItem('@parent_session');
    } catch (e) {
      console.log('Error clearing session:', e);
    }
    setIsLoggedIn(false);
    setStudents([]);
    setSelectedStudent(null);
    setAttendanceLogs([]);
  };

  const fetchAttendance = async (studentId, currentInstCode) => {
    const code = (currentInstCode || instituteCode || '').trim().toLowerCase();
    if (!code || !studentId) return;

    try {
      const res = await fetchWithTimeout(
        `${SERVER_URL}/api/institutes/${code}/students/${studentId}/attendance`,
        {},
        8000
      );
      if (!res.ok) return;
      const logs = await res.json();
      if (Array.isArray(logs)) {
        setAttendanceLogs(logs);
      }
    } catch (err) {
      console.error('Error fetching logs:', err);
    }
  };

  const onRefresh = useCallback(async () => {
    if (!selectedStudent) return;
    setRefreshing(true);
    await fetchAttendance(selectedStudent.student_id);
    setRefreshing(false);
  }, [selectedStudent, instituteCode]);

  // Test Sound Feature on Working Dashboard Page
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
          vibrate: [0, 500, 250, 500],
        },
        trigger: null,
      });
      Alert.alert(
        'Loud Alert Triggered',
        'Your phone notification bar received a maximum-volume alert chime and vibration! You will hear this loud alert whenever attendance is recorded.'
      );
    } catch (err) {
      console.log('Sound test error:', err);
    }
  };

  const getTodayStatus = () => {
    if (!attendanceLogs || attendanceLogs.length === 0) return null;
    const latest = attendanceLogs[0];
    const punchDate = new Date(latest.punch_time);
    const today = new Date();
    const isToday =
      punchDate.getDate() === today.getDate() &&
      punchDate.getMonth() === today.getMonth() &&
      punchDate.getFullYear() === today.getFullYear();

    if (!isToday) return null;
    return latest;
  };

  const todayLatest = getTodayStatus();

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
          timeStr = dateObj.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
          });
        }
      }
    } catch (e) {
      console.log('Date parse error', e);
    }

    return (
      <View>
        {getDateHeader(item, index)}
        <View style={styles.logCard}>
          <PunchDirectionIcon isEntry={isEntry} size={22} />

          <View style={styles.logInfo}>
            <View style={styles.logRow}>
              <Text style={styles.logTime}>{timeStr}</Text>
              <View style={[styles.badge, isEntry ? styles.badgeEntry : styles.badgeExit]}>
                <Text style={[styles.badgeText, isEntry ? styles.badgeTextEntry : styles.badgeTextExit]}>
                  {item.punch_type}
                </Text>
              </View>
            </View>
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
        /* ================= CLEAN LOGIN SCREEN ================= */
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
              <Text style={styles.cardHeader}>Parent Login</Text>

              {/* Institute Code Input */}
              <View style={[styles.inputContainer, { marginTop: 16 }]}>
                <Text style={styles.fieldLabel}>INSTITUTE CODE</Text>
                <TextInput
                  style={[styles.textInputFull, { textTransform: 'lowercase', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }]}
                  placeholder="Enter Institute Code"
                  placeholderTextColor="#94A3B8"
                  autoCapitalize="none"
                  value={instituteCode}
                  onChangeText={setInstituteCode}
                />
              </View>

              {/* Parent Phone Number Input */}
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

              {/* Small Privacy Policy Notice */}
              <View style={styles.privacyContainer}>
                <Text style={styles.privacyText}>
                  By continuing, you agree to our{' '}
                  <Text
                    style={styles.privacyLink}
                    onPress={() => Linking.openURL(`${SERVER_URL}/privacy-policy`)}
                  >
                    Privacy Policy
                  </Text>
                  . Student biometric records are encrypted and protected.
                </Text>
              </View>
            </View>
          </View>
        </ScrollView>
      ) : (
        /* ================= WORKING DASHBOARD SCREEN ================= */
        <View style={styles.dashboardWrapper}>
          <View style={styles.dashboardHeader}>
            <View style={styles.headerLeft}>
              <View style={styles.avatarCircle}>
                <Text style={styles.avatarInitial}>
                  {selectedStudent?.name ? selectedStudent.name.charAt(0).toUpperCase() : 'S'}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.headerStudentName} numberOfLines={1}>
                  {selectedStudent?.name || 'Student'}
                </Text>
                <Text style={styles.headerGradeText}>
                  {selectedStudent?.institute_name || instituteCode.toUpperCase()} • ID: #{selectedStudent?.student_id}
                </Text>
              </View>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {/* Sound Test Icon Button */}
              <TouchableOpacity
                onPress={handleTestSound}
                style={styles.soundBtn}
                activeOpacity={0.75}
              >
                <ChimeIcon size={18} color="#FFFFFF" />
              </TouchableOpacity>

              {/* Logout Button */}
              <TouchableOpacity
                onPress={handleLogout}
                style={styles.logoutBtn}
                activeOpacity={0.75}
              >
                <ExitDoorIcon size={14} color="#FFFFFF" />
                <Text style={styles.logoutBtnText}>Logout</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Student Tabs if multiple enrolled under same parent */}
          {students.length > 1 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll}>
              {students.map((s) => (
                <TouchableOpacity
                  key={s.student_id}
                  style={[
                    styles.tabItem,
                    selectedStudent?.student_id === s.student_id && styles.activeTabItem,
                  ]}
                  onPress={() => {
                    setSelectedStudent(s);
                    fetchAttendance(s.student_id);
                    AsyncStorage.setItem(
                      '@parent_session',
                      JSON.stringify({
                        instituteCode: instituteCode.trim().toLowerCase(),
                        phone: phone.trim(),
                        selectedStudentId: s.student_id,
                      })
                    ).catch(() => {});
                  }}
                >
                  <Text
                    style={[
                      styles.tabText,
                      selectedStudent?.student_id === s.student_id && styles.activeTabText,
                    ]}
                  >
                    {s.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          {/* Live Status Bar with Sync Indicator and Refresh Button */}
          <View style={styles.liveStatusBar}>
            <View style={styles.liveIndicatorRow}>
              <View style={styles.livePulseDot} />
              <Text style={styles.liveIndicatorText}>LIVE SYNC ACTIVE</Text>
            </View>
            <TouchableOpacity
              style={styles.refreshBtn}
              onPress={onRefresh}
              disabled={refreshing}
              activeOpacity={0.7}
            >
              {refreshing ? (
                <ActivityIndicator size="small" color="#4F46E5" style={{ marginRight: 6 }} />
              ) : (
                <SyncCycleIcon size={14} color="#4F46E5" />
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
                    ? todayLatest.punch_type === 'ENTRY'
                      ? 'Currently IN'
                      : 'Checked OUT'
                    : 'No Activity Today'}
                </Text>
              </View>
              <Text style={styles.todaySubText}>
                {todayLatest
                  ? `Last punch at ${new Date(todayLatest.punch_time).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })} • ${todayLatest.device_name || 'Biometric Gate'}`
                  : 'Waiting for biometric gate scan'}
              </Text>
            </View>
            <View style={styles.todayBadge}>
              <StatusCrest status={todayLatest ? todayLatest.punch_type : 'NONE'} size={42} />
            </View>
          </View>

          {/* Attendance History */}
          <View style={styles.historyContainer}>
            <View style={styles.sectionHeadingRow}>
              <Text style={styles.sectionHeading}>Attendance History</Text>
              <Text style={styles.recordsCount}>{attendanceLogs.length} events</Text>
            </View>

            <FlatList
              data={attendanceLogs}
              keyExtractor={(item) => item.id.toString()}
              renderItem={renderAttendanceItem}
              refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#4F46E5']} />
              }
              contentContainerStyle={styles.listContent}
              ListEmptyComponent={
                <View style={styles.emptyState}>
                  <EmptyAttendanceGraphic size={64} />
                  <Text style={styles.emptyTitle}>No Attendance Records Found</Text>
                  <Text style={styles.emptyDesc}>
                    When {selectedStudent?.name} punches on this institute's biometric scanner, logs will show here instantly.
                  </Text>
                </View>
              }
            />
          </View>
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
  logoIcon: {
    fontSize: 28,
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
    marginBottom: 6,
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
    fontSize: 15,
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
  privacyContainer: {
    marginTop: 14,
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  privacyText: {
    fontSize: 11,
    color: '#94A3B8',
    textAlign: 'center',
    lineHeight: 16,
  },
  privacyLink: {
    color: '#4F46E5',
    fontWeight: '700',
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
    paddingBottom: 20,
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
    fontSize: 18,
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
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoutBtn: {
    backgroundColor: 'rgba(255,255,255,0.18)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  logoutBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  tabsScroll: {
    backgroundColor: '#3730A3',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  tabItem: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.1)',
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
    color: '#3730A3',
    fontWeight: '700',
  },
  liveStatusBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 18,
    marginTop: 14,
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
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#C7D2FE',
  },
  refreshIcon: {
    fontSize: 12,
    marginRight: 4,
  },
  refreshBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#4F46E5',
  },
  todayCard: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 6,
    padding: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
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
    textTransform: 'uppercase',
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
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  todayBadgeIcon: {
    fontSize: 22,
  },
  historyContainer: {
    flex: 1,
    marginTop: 14,
    paddingHorizontal: 16,
  },
  sectionHeadingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  sectionHeading: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1E293B',
  },
  recordsCount: {
    fontSize: 12,
    color: '#64748B',
  },
  dateHeaderContainer: {
    backgroundColor: '#EEF2FF',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 10,
    marginTop: 12,
    marginBottom: 8,
    alignSelf: 'flex-start',
  },
  dateHeaderText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#4338CA',
  },
  listContent: {
    paddingBottom: 24,
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
  punchIconContainer: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  punchIconText: {
    fontSize: 12,
    fontWeight: '800',
  },
  entryBg: {
    backgroundColor: '#DCFCE7',
  },
  exitBg: {
    backgroundColor: '#FEE2E2',
  },
  entryColor: {
    color: '#15803D',
  },
  exitColor: {
    color: '#B91C1C',
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
    fontSize: 16,
    fontWeight: '700',
    color: '#0F172A',
  },
  badge: {
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  badgeEntry: {
    backgroundColor: '#DCFCE7',
  },
  badgeExit: {
    backgroundColor: '#FEE2E2',
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  badgeTextEntry: {
    color: '#166534',
  },
  badgeTextExit: {
    color: '#991B1B',
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
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    paddingHorizontal: 24,
  },
  emptyIcon: {
    fontSize: 40,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 6,
  },
  emptyDesc: {
    fontSize: 13,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 18,
  },
});
