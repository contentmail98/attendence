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
  Modal,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

// Default server URL — change this or use the in-app Settings gear ⚙️
const DEFAULT_SERVER_URL = 'http://192.168.29.73:8000';

// Helper: fetch with timeout (default 10 seconds)
function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Request timed out after ${timeoutMs / 1000}s. Server at ${url} is not reachable from this device.`));
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
  const [instituteCode, setInstituteCode] = useState('prepx');
  const [phone, setPhone] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [students, setStudents] = useState([]);
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [attendanceLogs, setAttendanceLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deviceToken, setDeviceToken] = useState(null);

  // Server URL (configurable from Settings)
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [showSettings, setShowSettings] = useState(false);
  const [tempServerUrl, setTempServerUrl] = useState(DEFAULT_SERVER_URL);
  const [testingConnection, setTestingConnection] = useState(false);

  useEffect(() => {
    registerForPushNotificationsAsync().then((token) => {
      if (token) setDeviceToken(token);
    });
  }, []);

  // Poll for live biometric updates
  useEffect(() => {
    if (!isLoggedIn || !selectedStudent) return;

    let lastKnownPunchId = null;

    const pollInterval = setInterval(async () => {
      try {
        const res = await fetchWithTimeout(
          `${serverUrl}/api/institutes/${instituteCode.trim().toLowerCase()}/students/${selectedStudent.student_id}/attendance`,
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

            // Pop OS system banner
            try {
              const isEntry = latest.punch_type === 'ENTRY';
              await Notifications.scheduleNotificationAsync({
                content: {
                  title: isEntry ? '🏫 Student Check-In' : '👋 Student Check-Out',
                  body: isEntry
                    ? `${selectedStudent.name} entered ${selectedStudent.institute_name || 'Center'}.`
                    : `${selectedStudent.name} has left the center.`,
                  sound: true,
                  vibrate: [0, 250, 250, 250],
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
  }, [isLoggedIn, selectedStudent, instituteCode, serverUrl]);

  async function registerForPushNotificationsAsync() {
    let token = null;
    try {
      if (Device.isDevice) {
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;
        if (existingStatus !== 'granted') {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }

        try {
          const expoTokenData = await Notifications.getExpoPushTokenAsync();
          token = expoTokenData?.data;
        } catch {
          token = `DeviceToken-${Device.osName || 'Mobile'}-${Date.now()}`;
        }
      } else {
        token = `SimulatorToken-${Date.now()}`;
      }

      if (Platform.OS === 'android') {
        try {
          await Notifications.setNotificationChannelAsync('default', {
            name: 'Attendance Alerts',
            importance: Notifications.AndroidImportance.MAX,
            vibrationPattern: [0, 250, 250, 250],
            lightColor: '#4F46E5',
            enableLights: true,
            enableVibrate: true,
          });
        } catch (channelErr) {
          console.log('Channel skipped in Expo Go');
        }
      }
    } catch (e) {
      token = `Device-${Platform.OS}-${Date.now()}`;
    }
    return token;
  }

  // Test connection to server
  const testConnection = async (url) => {
    setTestingConnection(true);
    try {
      const testUrl = url.replace(/\/+$/, ''); // remove trailing slash
      const res = await fetchWithTimeout(`${testUrl}/health`, {}, 5000);
      const data = await res.json();
      Alert.alert('✅ Connected!', `Server is online.\nMode: ${data.mode || 'unknown'}\n\nYou can now login.`);
      return true;
    } catch (err) {
      Alert.alert(
        '❌ Cannot Connect',
        `Failed to reach: ${url}/health\n\nError: ${err.message}\n\nMake sure:\n1. python main.py is running on your PC\n2. Your phone can reach that IP\n3. Try using ngrok if on different networks`
      );
      return false;
    } finally {
      setTestingConnection(false);
    }
  };

  // Handle Login with Institute Code + Mobile Number
  const handleLogin = async () => {
    const cleanCode = instituteCode.trim().toLowerCase();
    const cleanPhone = phone.trim();

    if (!cleanCode) {
      Alert.alert('Required', 'Please enter your Coaching Institute Code (e.g. apex).');
      return;
    }
    if (!cleanPhone) {
      Alert.alert('Required', 'Please enter your registered mobile number.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetchWithTimeout(
        `${serverUrl}/api/institutes/${cleanCode}/parents/${cleanPhone}/students`,
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
          `No student found for phone number "${cleanPhone}" under Institute "${cleanCode.toUpperCase()}".\n\nPlease check the registered phone number in that center's portal.`
        );
        setLoading(false);
        return;
      }

      setStudents(data);
      const student = data[0];
      setSelectedStudent(student);
      setIsLoggedIn(true);

      // Register device token on multi-tenant server (non-blocking)
      const pushTokenToSend = deviceToken || `ActiveApp-${cleanPhone}`;
      fetch(`${serverUrl}/api/parents/register-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          institute_code: cleanCode,
          parent_phone: cleanPhone,
          expo_push_token: pushTokenToSend,
        }),
      }).catch((e) => console.log('Token sync error:', e));

      // Fetch attendance records
      fetchAttendance(student.student_id);
    } catch (err) {
      console.log('Login error:', err.name, err.message);
      let msg;
      if (err.message && err.message.includes('timed out')) {
        msg = `Cannot reach server at ${serverUrl}.\n\nTap the ⚙️ icon to check your Server URL, or use the "Test Connection" button.`;
      } else if (err.message && (err.message.includes('Network request failed') || err.message.includes('fetch'))) {
        msg = `Network error reaching ${serverUrl}.\n\nTap ⚙️ to verify your Server URL and test the connection.`;
      } else {
        msg = err.message || 'Cannot connect to server';
      }
      Alert.alert('Login Failed', msg);
    } finally {
      setLoading(false);
    }
  };

  const fetchAttendance = async (studentId) => {
    try {
      const res = await fetchWithTimeout(
        `${serverUrl}/api/institutes/${instituteCode.trim().toLowerCase()}/students/${studentId}/attendance`,
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
  }, [selectedStudent, instituteCode, serverUrl]);

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

  const renderAttendanceItem = ({ item }) => {
    if (!item) return null;
    const isEntry = item.punch_type === 'ENTRY';
    let dateStr = 'Today';
    let timeStr = '--:--';

    try {
      if (item.punch_time) {
        const dateObj = new Date(item.punch_time);
        if (!isNaN(dateObj.getTime())) {
          dateStr = dateObj.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          });
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
      <View style={styles.logCard}>
        <View style={[styles.punchIconContainer, isEntry ? styles.entryBg : styles.exitBg]}>
          <Text style={[styles.punchIconText, isEntry ? styles.entryColor : styles.exitColor]}>
            {isEntry ? '➔ In' : '← Out'}
          </Text>
        </View>

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
            <Text style={styles.logDate}>{dateStr}</Text>
            <Text style={styles.deviceLabel}>📍 {item.device_name || 'Biometric Gate'}</Text>
          </View>
        </View>
      </View>
    );
  };

  // ======================== SETTINGS MODAL ========================
  const renderSettingsModal = () => (
    <Modal visible={showSettings} animationType="slide" transparent>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>⚙️ Server Settings</Text>
          <Text style={styles.modalDesc}>
            Enter the URL where your Python backend is running. Use your PC's Wi-Fi IP, or an ngrok URL for remote access.
          </Text>

          <Text style={styles.fieldLabel}>SERVER URL</Text>
          <TextInput
            style={styles.textInputFull}
            value={tempServerUrl}
            onChangeText={setTempServerUrl}
            placeholder="http://192.168.29.73:8000"
            placeholderTextColor="#94A3B8"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          <TouchableOpacity
            style={[styles.signInButton, { backgroundColor: '#059669', marginTop: 12 }]}
            onPress={() => testConnection(tempServerUrl.trim().replace(/\/+$/, ''))}
            disabled={testingConnection}
          >
            {testingConnection ? (
              <ActivityIndicator color="#FFF" />
            ) : (
              <Text style={styles.signInButtonText}>🔗 Test Connection</Text>
            )}
          </TouchableOpacity>

          <View style={{ flexDirection: 'row', marginTop: 12, gap: 8 }}>
            <TouchableOpacity
              style={[styles.signInButton, { flex: 1, backgroundColor: '#4F46E5' }]}
              onPress={() => {
                const cleaned = tempServerUrl.trim().replace(/\/+$/, '');
                setServerUrl(cleaned);
                setShowSettings(false);
                Alert.alert('Saved', `Server URL set to:\n${cleaned}`);
              }}
            >
              <Text style={styles.signInButtonText}>💾 Save</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.signInButton, { flex: 1, backgroundColor: '#64748B' }]}
              onPress={() => {
                setTempServerUrl(serverUrl);
                setShowSettings(false);
              }}
            >
              <Text style={styles.signInButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.helpBox}>
            <Text style={styles.helpTitle}>💡 Connection Tips</Text>
            <Text style={styles.helpText}>• Same Wi-Fi: Use PC's IP (e.g. http://192.168.29.73:8000)</Text>
            <Text style={styles.helpText}>• Mobile Data: Use ngrok URL (e.g. https://abc.ngrok-free.app)</Text>
            <Text style={styles.helpText}>• Find PC IP: Run "ipconfig" in PowerShell → Wi-Fi IPv4</Text>
          </View>
        </View>
      </View>
    </Modal>
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#4338CA" translucent={false} />

      {renderSettingsModal()}

      {!isLoggedIn ? (
        /* ================= MULTI-TENANT LOGIN SCREEN ================= */
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
          <View style={styles.loginWrapper}>
            <View style={styles.heroSection}>
              <View style={styles.logoCircle}>
                <Text style={styles.logoIcon}>🏢</Text>
              </View>
              <Text style={styles.heroTitle}>Student Center</Text>
              <Text style={styles.heroSubtitle}>Multi-Institute Parent Attendance Portal</Text>
            </View>

            <View style={styles.loginCard}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={styles.cardHeader}>Parent Login</Text>
                <TouchableOpacity
                  onPress={() => {
                    setTempServerUrl(serverUrl);
                    setShowSettings(true);
                  }}
                  style={styles.settingsBtn}
                >
                  <Text style={{ fontSize: 20 }}>⚙️</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.cardSub}>
                Enter your child's Coaching Institute Code and your registered mobile number.
              </Text>

              {/* Server URL indicator */}
              <TouchableOpacity
                onPress={() => {
                  setTempServerUrl(serverUrl);
                  setShowSettings(true);
                }}
                style={styles.serverIndicator}
              >
                <Text style={styles.serverIndicatorText}>🖥️ {serverUrl}</Text>
              </TouchableOpacity>

              {/* Institute Code Input */}
              <View style={styles.inputContainer}>
                <Text style={styles.fieldLabel}>INSTITUTE CODE</Text>
                <TextInput
                  style={[styles.textInputFull, { textTransform: 'lowercase', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }]}
                  placeholder="e.g. apex or allen"
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
                  <Text style={styles.countryCode}>🇮🇳 +91</Text>
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
                  <Text style={styles.signInButtonText}>Enter Institute Portal ➔</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      ) : (
        /* ================= DASHBOARD SCREEN ================= */
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
                  {selectedStudent?.institute_name} • ID: #{selectedStudent?.student_id}
                </Text>
              </View>
            </View>

            <TouchableOpacity
              onPress={() => {
                setIsLoggedIn(false);
              }}
              style={styles.logoutBtn}
            >
              <Text style={styles.logoutBtnText}>Logout</Text>
            </TouchableOpacity>
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

          {/* Today Status Banner */}
          <View style={styles.statusBanner}>
            <View style={styles.statusLeft}>
              <Text style={styles.statusTitle}>Today's Status</Text>
              {todayLatest ? (
                <Text style={styles.statusValue}>
                  {todayLatest.punch_type === 'ENTRY' ? '🟢 Currently IN' : '🔴 Checked OUT'} at{' '}
                  {new Date(todayLatest.punch_time).toLocaleTimeString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Text>
              ) : (
                <Text style={styles.statusValue}>⚪ No activity today</Text>
              )}
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
                  <Text style={styles.emptyIcon}>📋</Text>
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
    marginTop: 3,
  },
  loginCard: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 20,
    marginTop: -26,
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
    fontWeight: '700',
    color: '#1E293B',
  },
  cardSub: {
    fontSize: 13,
    color: '#64748B',
    marginTop: 4,
    marginBottom: 10,
    lineHeight: 18,
  },
  settingsBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  serverIndicator: {
    backgroundColor: '#F1F5F9',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  serverIndicatorText: {
    fontSize: 11,
    color: '#64748B',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
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
  countryCode: {
    fontSize: 15,
    fontWeight: '600',
    color: '#334155',
    marginRight: 8,
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
    marginTop: 6,
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

  /* SETTINGS MODAL */
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  modalContent: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 24,
    maxHeight: '85%',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#1E293B',
    marginBottom: 6,
  },
  modalDesc: {
    fontSize: 13,
    color: '#64748B',
    lineHeight: 18,
    marginBottom: 16,
  },
  helpBox: {
    backgroundColor: '#F1F5F9',
    borderRadius: 12,
    padding: 14,
    marginTop: 16,
  },
  helpTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 6,
  },
  helpText: {
    fontSize: 12,
    color: '#64748B',
    lineHeight: 20,
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
    paddingBottom: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 12,
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
  logoutBtn: {
    backgroundColor: 'rgba(255,255,255,0.18)',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  logoutBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
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
  statusBanner: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 16,
    marginTop: 14,
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  statusLeft: {
    flex: 1,
  },
  statusTitle: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    color: '#64748B',
    letterSpacing: 0.5,
  },
  statusValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1E293B',
    marginTop: 3,
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
    marginBottom: 10,
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
  listContent: {
    paddingBottom: 24,
  },
  logCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  punchIconContainer: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  punchIconText: {
    fontSize: 13,
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
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  logDate: {
    fontSize: 12,
    color: '#64748B',
    fontWeight: '500',
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
