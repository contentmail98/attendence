import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

/**
 * 1. Academy Emblem Icon (Replacing generic school emoji 🏫)
 * Clean geometric graduation cap & knowledge crest
 */
export function AcademyEmblem({ size = 52, color = '#FFFFFF' }) {
  return (
    <View style={[styles.emblemContainer, { width: size, height: size }]}>
      {/* Cap Diamond Top */}
      <View style={[styles.capTop, { borderColor: color }]} />
      {/* Cap Skull Underneath */}
      <View style={[styles.capSkull, { backgroundColor: color }]} />
      {/* Tassel String */}
      <View style={[styles.capTassel, { backgroundColor: '#FCD34D' }]} />
      {/* Pedestal Base */}
      <View style={[styles.capBase, { backgroundColor: color }]} />
    </View>
  );
}

/**
 * 2. Sound Chime Icon (Replacing generic speaker emoji 🔊)
 * Modern geometric speaker horn with dual audio waves
 */
export function ChimeIcon({ size = 20, color = '#FFFFFF' }) {
  return (
    <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
      <View style={styles.speakerRow}>
        {/* Speaker back box */}
        <View style={[styles.speakerBox, { backgroundColor: color }]} />
        {/* Speaker cone */}
        <View style={[styles.speakerCone, { borderRightColor: color }]} />
        {/* Sound Waves */}
        <View style={styles.wavesCol}>
          <View style={[styles.waveArcSmall, { borderColor: color }]} />
          <View style={[styles.waveArcBig, { borderColor: color }]} />
        </View>
      </View>
    </View>
  );
}

/**
 * 3. Logout Door Icon (Replacing plain text or default exit)
 */
export function ExitDoorIcon({ size = 16, color = '#FFFFFF' }) {
  return (
    <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
      {/* Door frame */}
      <View style={[styles.doorFrame, { borderColor: color }]}>
        {/* Arrow passing through */}
        <View style={[styles.arrowShaft, { backgroundColor: color }]} />
        <View style={[styles.arrowHead, { borderLeftColor: color }]} />
      </View>
    </View>
  );
}

/**
 * 4. Sync Refresh Icon (Replacing generic 🔄)
 */
export function SyncCycleIcon({ size = 16, color = '#4F46E5', isSpinning = false }) {
  return (
    <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
      <View style={[styles.syncRing, { borderColor: color }]}>
        <View style={[styles.syncPointer, { borderTopColor: color }]} />
      </View>
    </View>
  );
}

/**
 * 5. Punch IN / OUT Custom Directional Icons
 */
export function PunchDirectionIcon({ isEntry = true, size = 24 }) {
  const primaryColor = isEntry ? '#059669' : '#DC2626';
  const bgColor = isEntry ? '#D1FAE5' : '#FEE2E2';

  return (
    <View style={[styles.punchBox, { width: size * 1.6, height: size * 1.6, backgroundColor: bgColor }]}>
      <View style={{ alignItems: 'center', justifyContent: 'center' }}>
        {/* Directional Arrow Bar */}
        <View style={[styles.punchArrowStem, { backgroundColor: primaryColor }]} />
        {/* Arrow Tip */}
        <View
          style={[
            isEntry ? styles.punchArrowDown : styles.punchArrowUp,
            { [isEntry ? 'borderTopColor' : 'borderBottomColor']: primaryColor },
          ]}
        />
      </View>
      <Text style={[styles.punchLabelTag, { color: primaryColor }]}>
        {isEntry ? 'IN' : 'OUT'}
      </Text>
    </View>
  );
}

/**
 * 6. Scanner Device Pin (Replacing generic 📍 pin)
 * Tech-inspired biometric scanner crosshair target
 */
export function ScannerTargetIcon({ size = 14, color = '#64748B' }) {
  return (
    <View style={[styles.targetWrapper, { width: size, height: size }]}>
      <View style={[styles.targetOuterRing, { borderColor: color }]}>
        <View style={[styles.targetCenterDot, { backgroundColor: color }]} />
      </View>
    </View>
  );
}

/**
 * 7. Calendar Date Badge Icon (Replacing generic 📅)
 */
export function CalendarBadgeIcon({ size = 16, color = '#4F46E5' }) {
  return (
    <View style={[styles.calContainer, { width: size, height: size, borderColor: color }]}>
      {/* Top Header Strip */}
      <View style={[styles.calHeader, { backgroundColor: color }]} />
      {/* Grid Dots */}
      <View style={styles.calGrid}>
        <View style={[styles.calDot, { backgroundColor: color }]} />
        <View style={[styles.calDot, { backgroundColor: color }]} />
        <View style={[styles.calDot, { backgroundColor: color }]} />
      </View>
    </View>
  );
}

/**
 * 8. Status Crest (Replacing 🏫, 👋, ⏳ in Today Card)
 */
export function StatusCrest({ status = 'NONE', size = 44 }) {
  if (status === 'ENTRY') {
    return (
      <View style={[styles.crestCircle, { width: size, height: size, backgroundColor: '#DCFCE7', borderColor: '#86EFAC' }]}>
        <View style={styles.checkStemShort} />
        <View style={styles.checkStemLong} />
      </View>
    );
  }

  if (status === 'EXIT') {
    return (
      <View style={[styles.crestCircle, { width: size, height: size, backgroundColor: '#FEE2E2', borderColor: '#FCA5A5' }]}>
        <View style={styles.exitBarOne} />
        <View style={styles.exitBarTwo} />
      </View>
    );
  }

  // Waiting / Neutral
  return (
    <View style={[styles.crestCircle, { width: size, height: size, backgroundColor: '#EDE9FE', borderColor: '#C4B5FD' }]}>
      <View style={styles.clockHour} />
      <View style={styles.clockMinute} />
    </View>
  );
}

/**
 * 9. Custom Empty State Graphic (Replacing generic 📋)
 */
export function EmptyAttendanceGraphic({ size = 70 }) {
  return (
    <View style={[styles.emptyGraphicCircle, { width: size, height: size }]}>
      {/* Card Sheet */}
      <View style={styles.sheetPaper}>
        {/* Clip at top */}
        <View style={styles.sheetClip} />
        {/* Placeholder lines */}
        <View style={styles.sheetLine} />
        <View style={[styles.sheetLine, { width: 22 }]} />
        <View style={[styles.sheetLine, { width: 14 }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // 1. Academy Emblem
  emblemContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  capTop: {
    width: 26,
    height: 12,
    borderWidth: 2,
    borderRadius: 2,
    transform: [{ rotate: '45deg' }],
  },
  capSkull: {
    width: 14,
    height: 7,
    borderBottomLeftRadius: 5,
    borderBottomRightRadius: 5,
    marginTop: -2,
  },
  capTassel: {
    position: 'absolute',
    right: 8,
    top: 14,
    width: 2,
    height: 9,
    borderRadius: 1,
  },
  capBase: {
    width: 20,
    height: 2,
    marginTop: 4,
    borderRadius: 1,
  },

  // 2. Chime
  speakerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  speakerBox: {
    width: 5,
    height: 7,
    borderTopLeftRadius: 1,
    borderBottomLeftRadius: 1,
  },
  speakerCone: {
    width: 0,
    height: 0,
    borderTopWidth: 6,
    borderBottomWidth: 6,
    borderRightWidth: 7,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },
  wavesCol: {
    marginLeft: 3,
    justifyContent: 'center',
    alignItems: 'center',
  },
  waveArcSmall: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 4,
    borderRightWidth: 2,
    borderTopWidth: 2,
    borderColor: 'transparent',
    transform: [{ rotate: '45deg' }],
  },
  waveArcBig: {
    width: 13,
    height: 13,
    borderRadius: 6.5,
    borderRightWidth: 2,
    borderTopWidth: 2,
    borderColor: 'transparent',
    transform: [{ rotate: '45deg' }],
  },

  // 3. Exit Door
  doorFrame: {
    width: 14,
    height: 14,
    borderWidth: 1.5,
    borderRightWidth: 0,
    borderRadius: 2,
    justifyContent: 'center',
  },
  arrowShaft: {
    position: 'absolute',
    left: 4,
    width: 10,
    height: 1.5,
  },
  arrowHead: {
    position: 'absolute',
    right: -4,
    width: 0,
    height: 0,
    borderTopWidth: 3,
    borderBottomWidth: 3,
    borderLeftWidth: 4,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },

  // 4. Sync
  syncRing: {
    width: 13,
    height: 13,
    borderRadius: 6.5,
    borderWidth: 1.8,
    borderRightColor: 'transparent',
    borderBottomColor: 'transparent',
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
  },
  syncPointer: {
    width: 0,
    height: 0,
    borderLeftWidth: 3,
    borderRightWidth: 3,
    borderTopWidth: 4,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    marginTop: -2,
    marginRight: -1,
  },

  // 5. Punch Direction Box
  punchBox: {
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 4,
  },
  punchArrowStem: {
    width: 3,
    height: 8,
    borderRadius: 1.5,
  },
  punchArrowDown: {
    width: 0,
    height: 0,
    borderLeftWidth: 4,
    borderRightWidth: 4,
    borderTopWidth: 5,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  punchArrowUp: {
    width: 0,
    height: 0,
    borderLeftWidth: 4,
    borderRightWidth: 4,
    borderBottomWidth: 5,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  punchLabelTag: {
    fontSize: 9,
    fontWeight: '900',
    marginTop: 2,
    letterSpacing: 0.5,
  },

  // 6. Scanner Target
  targetWrapper: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  targetOuterRing: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1.5,
    justifyContent: 'center',
    alignItems: 'center',
  },
  targetCenterDot: {
    width: 3.5,
    height: 3.5,
    borderRadius: 2,
  },

  // 7. Calendar
  calContainer: {
    borderWidth: 1.5,
    borderRadius: 3.5,
    overflow: 'hidden',
  },
  calHeader: {
    height: 4,
    width: '100%',
  },
  calGrid: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'center',
  },
  calDot: {
    width: 2,
    height: 2,
    borderRadius: 1,
  },

  // 8. Status Crest
  crestCircle: {
    borderRadius: 22,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkStemShort: {
    position: 'absolute',
    width: 3,
    height: 8,
    backgroundColor: '#059669',
    borderRadius: 1.5,
    transform: [{ rotate: '-45deg' }],
    left: 14,
    top: 20,
  },
  checkStemLong: {
    position: 'absolute',
    width: 3,
    height: 16,
    backgroundColor: '#059669',
    borderRadius: 1.5,
    transform: [{ rotate: '45deg' }],
    left: 21,
    top: 13,
  },
  exitBarOne: {
    position: 'absolute',
    width: 3,
    height: 18,
    backgroundColor: '#DC2626',
    borderRadius: 1.5,
    transform: [{ rotate: '45deg' }],
  },
  exitBarTwo: {
    position: 'absolute',
    width: 3,
    height: 18,
    backgroundColor: '#DC2626',
    borderRadius: 1.5,
    transform: [{ rotate: '-45deg' }],
  },
  clockHour: {
    position: 'absolute',
    width: 2.5,
    height: 9,
    backgroundColor: '#6366F1',
    borderRadius: 1.5,
    top: 13,
  },
  clockMinute: {
    position: 'absolute',
    width: 7,
    height: 2.5,
    backgroundColor: '#6366F1',
    borderRadius: 1.5,
    left: 20,
    top: 20,
  },

  // 9. Empty State
  emptyGraphicCircle: {
    borderRadius: 35,
    backgroundColor: '#EEF2FF',
    borderWidth: 2,
    borderColor: '#C7D2FE',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  sheetPaper: {
    width: 30,
    height: 38,
    backgroundColor: '#FFFFFF',
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: '#818CF8',
    padding: 4,
    alignItems: 'center',
  },
  sheetClip: {
    width: 12,
    height: 4,
    backgroundColor: '#4F46E5',
    borderRadius: 2,
    marginBottom: 5,
  },
  sheetLine: {
    width: 20,
    height: 2.5,
    backgroundColor: '#C7D2FE',
    borderRadius: 1.5,
    marginBottom: 3.5,
  },
});
