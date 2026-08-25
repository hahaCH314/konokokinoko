import React, { useCallback, useEffect, useReducer, useRef, useState, useMemo } from 'react';
import { Animated, Dimensions, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAudioPlayer } from 'expo-audio';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Billboard, Image as DreiImage, Points, PointMaterial } from '@react-three/drei';
import * as THREE from 'three';

import LINES from './mushroomLines.json';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

const Z_FAR = 80;
const Z_NEAR = 2;
const WALK_SPEED = 18;
const SPREAD = 30; // 3D world width
const PATH_CLEAR = 0.25; 
const SPAWN_EVERY = 1.1;
const MAX_ALIVE = 8;
const SPEAK_AT = 15;

const POWER_STEP = 0.018;
const POWER_MAX = 0.25;

const EXIT_MIN = 120;
const EXIT_MAX = 300;

const SCENES = [
  { src: require('./assets/forest_1_entrance.jpg') },
  { src: require('./assets/forest_2_steps.jpg') },
  { src: require('./assets/forest_3_clearing.jpg') },
  { src: require('./assets/forest_4_water.jpg') },
  { src: require('./assets/forest_5_deep.jpg') },
  { src: require('./assets/forest_6_night.jpg') },
  { src: require('./assets/forest_7_exit.jpg') },
  { src: require('./assets/forest_7_exit.jpg') },
];

const MUSHROOMS = [
  { type: 'shiitake', src: require('./assets/char_mushroom_1.png') },
  { type: 'king_oyster', src: require('./assets/char_mushroom_2.png') },
  { type: 'nameko', src: require('./assets/char_mushroom_3.png') },
  { type: 'matsutake', src: require('./assets/char_mushroom_4.png') },
  { type: 'black_truffle', src: require('./assets/char_mushroom_5.png') },
];

const TITLE_FRAMES = [
  require('./assets/title_1_closed.png'),
  require('./assets/title_2_open.png'),
  require('./assets/title_3_wide.png'),
];

const TITLE_W = 1000;
const TITLE_H = 1414;
const MOUTH_X = 0.47;
const MOUTH_Y = 0.58;
const HAND_RATIO = 0.075;
const HAND_TILT = 28;
const HAND_OFF_X = 0.85;
const HAND_OFF_Y = 0.15;
const FRAME_MS = 240;

function mouthOnScreen() {
  const aspect = TITLE_W / TITLE_H;
  const w = Math.min(SCREEN_WIDTH, SCREEN_HEIGHT * aspect);
  const h = w / aspect;
  return {
    x: (SCREEN_WIDTH - w) / 2 + w * MOUTH_X,
    y: (SCREEN_HEIGHT - h) / 2 + h * MOUTH_Y,
    size: w,
  };
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function lineFor(type, isNight) {
  const own = LINES[type]?.lines || [];
  const c = LINES.common || {};
  const pool = isNight
    ? [...(c.heal || []), ...(c.heal || []), ...(c.cheer || []), ...(c.funny || [])]
    : [...(c.cheer || []), ...(c.cheer || []), ...(c.heal || []), ...(c.funny || [])];
  return pick([...own, ...own, ...pool]);
}

const readingTime = (text) => 1500 + text.length * 120;


// ============================================================================
// 3D Engine Components
// ============================================================================

function DustParticles({ cameraZ }) {
  const count = 50;
  const positions = useMemo(() => {
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 40;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 20;
      pos[i * 3 + 2] = cameraZ - Math.random() * Z_FAR;
    }
    return pos;
  }, []);

  const pointsRef = useRef();

  useFrame(() => {
    if (!pointsRef.current) return;
    const pos = pointsRef.current.geometry.attributes.position.array;
    for (let i = 0; i < count; i++) {
      if (pos[i * 3 + 2] > cameraZ) {
        pos[i * 3 + 2] = cameraZ - Z_FAR;
        pos[i * 3] = (Math.random() - 0.5) * 40;
        pos[i * 3 + 1] = (Math.random() - 0.5) * 20;
      }
    }
    pointsRef.current.geometry.attributes.position.needsUpdate = true;
  });

  return (
    <Points ref={pointsRef} positions={positions}>
      <PointMaterial transparent color="#ffffff" size={0.3} sizeAttenuation={true} depthWrite={false} opacity={0.6} />
    </Points>
  );
}

function MushroomBillboard({ item, cameraZ, isNight, onSpeak }) {
  const ref = useRef();
  
  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.elapsedTime;
    
    // Breathing & Swaying
    ref.current.scale.y = 8 + Math.sin(t * 2 + item.wx) * 0.3;
    ref.current.rotation.z = Math.sin(t * 1.5 + item.wx) * 0.05;

    // Check speak
    const dist = item.z - cameraZ;
    if (!item.spoke && dist > -SPEAK_AT && dist < 0) {
      item.spoke = true;
      onSpeak(item);
    }
  });

  const color = isNight ? new THREE.Color(0.4, 0.6, 0.8) : new THREE.Color(1, 0.9, 0.8);

  return (
    <Billboard position={[item.wx, -3, item.z]} ref={ref}>
      <DreiImage url={item.src} scale={[8, 8]} transparent depthWrite={false} color={color} />
      <mesh position={[0, -4, -0.1]}>
        <planeGeometry args={[6, 1.5]} />
        <meshBasicMaterial color="black" transparent opacity={0.4} />
      </mesh>
    </Billboard>
  );
}

function BackgroundCrossfade({ sceneIndex, cameraZ, isNight, power, phase }) {
  const [currentIdx, setCurrentIdx] = useState(sceneIndex);
  const [nextIdx, setNextIdx] = useState(null);
  const fade = useRef(0);

  useEffect(() => {
    if (sceneIndex !== currentIdx) {
      setNextIdx(sceneIndex);
      fade.current = 0;
    }
  }, [sceneIndex, currentIdx]);

  useFrame((state, delta) => {
    if (nextIdx !== null) {
      fade.current += delta / 2.5; 
      if (fade.current >= 1) {
        setCurrentIdx(nextIdx);
        setNextIdx(null);
        fade.current = 0;
      }
    }
  });

  const bgZ = cameraZ - 70; 

  const currentSrc = phase === 'exit' ? require('./assets/forest_7_exit.jpg') : SCENES[currentIdx].src;
  const nextSrc = nextIdx !== null ? SCENES[nextIdx].src : null;

  return (
    <group position={[0, 0, bgZ]}>
      <DreiImage url={currentSrc} scale={[120, 90]} transparent opacity={1} depthWrite={false} />
      {nextSrc && (
        <DreiImage url={nextSrc} scale={[120, 90]} transparent opacity={fade.current} depthWrite={false} />
      )}
      
      {isNight && (
        <mesh position={[0, 0, 1]}>
          <planeGeometry args={[120, 90]} />
          <meshBasicMaterial color="#000714" transparent opacity={Math.max(0, 0.72 - power * 1.6)} />
        </mesh>
      )}
      {!isNight && power > 0 && (
        <mesh position={[0, 0, 1]}>
          <planeGeometry args={[120, 90]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={power * 0.5} blending={THREE.AdditiveBlending} />
        </mesh>
      )}
    </group>
  );
}

function WorldScene({ isWalking, walkedRef, itemsRef, sceneIndex, phase, isNight, power, onSpeak }) {
  const { camera } = useThree();
  const [cameraZ, setCameraZ] = useState(0);

  useFrame((state, delta) => {
    if (isWalking) {
      const t = state.clock.elapsedTime;
      
      walkedRef.current += WALK_SPEED * delta;
      
      camera.position.z = -walkedRef.current;
      setCameraZ(camera.position.z);

      camera.position.y = Math.sin(t * Math.PI * 3) * 0.5;
      camera.position.x = Math.sin(t * Math.PI * 1.5) * 1.5;
    }
  });

  return (
    <>
      <BackgroundCrossfade sceneIndex={sceneIndex} cameraZ={cameraZ} isNight={isNight} power={power} phase={phase} />
      
      {itemsRef.current.map(it => (
        <MushroomBillboard key={it.key} item={it} cameraZ={cameraZ} isNight={isNight} onSpeak={onSpeak} />
      ))}
      
      {isWalking && <DustParticles cameraZ={cameraZ} />}
    </>
  );
}


// ============================================================================
// React Native UI App
// ============================================================================

export default function App() {
  const [phase, setPhase] = useState('title');
  const [mouthFrame, setMouthFrame] = useState(0);
  const [isNight, setIsNight] = useState(false);
  const [isWalking, setIsWalking] = useState(false);
  const [sceneIndex, setSceneIndex] = useState(0);
  const [speech, setSpeech] = useState(null);
  const [power, setPower] = useState(0);

  const itemsRef = useRef([]);
  const seqRef = useRef(0);
  const spawnInRef = useRef(0);
  
  const walkingRef = useRef(false);
  const walkedRef = useRef(0);
  const exitAtRef = useRef(EXIT_MIN + Math.random() * (EXIT_MAX - EXIT_MIN));
  const nightRef = useRef(false);
  const speechRef = useRef(null);
  const speechTimer = useRef(null);

  const curtain = useRef(new Animated.Value(0)).current;
  const zoom = useRef(new Animated.Value(1)).current;
  const tapOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(tapOpacity, { toValue: 0, duration: 600, useNativeDriver: true }),
        Animated.timing(tapOpacity, { toValue: 1, duration: 600, useNativeDriver: true })
      ])
    ).start();
  }, [tapOpacity]);

  const cave = useAudioPlayer(require('./assets/footsteps.mp3')); // fallback
  const ambDay = useAudioPlayer(require('./assets/trees.mp3'));
  const ambNight = useAudioPlayer(require('./assets/night_bgm.mp3'));
  const wind = useAudioPlayer(require('./assets/trees.mp3')); // fallback
  const stream = useAudioPlayer(require('./assets/trees.mp3')); // fallback
  const steps = useAudioPlayer(require('./assets/footsteps.mp3'));

  useEffect(() => {
    cave.loop = true; ambDay.loop = true; ambNight.loop = true;
    wind.loop = true; stream.loop = true; steps.loop = true;
  }, [cave, ambDay, ambNight, wind, stream, steps]);

  const say = useCallback((item) => {
    const text = lineFor(item.type, nightRef.current);
    setSpeech(text);
    speechRef.current = text;
    setPower((p) => Math.min(POWER_MAX, p + POWER_STEP));
    
    if (speechTimer.current) clearTimeout(speechTimer.current);
    speechTimer.current = setTimeout(() => {
      setSpeech(null);
      speechRef.current = null;
    }, readingTime(text));
  }, []);

  const zoomIn = useCallback(() => {
    Animated.timing(zoom, { toValue: 12, duration: 1500, useNativeDriver: false }).start(() => {
      setPhase('walking');
      walkedRef.current = 0;
      exitAtRef.current = EXIT_MIN + Math.random() * (EXIT_MAX - EXIT_MIN);
      itemsRef.current = [];
      setIsNight(false);
      nightRef.current = false;
      setSceneIndex(0);
      setPower(0);
      
      cave.pause();
      ambDay.seekTo(0); ambDay.play();
      wind.seekTo(0); wind.play();
      
      startWalk();
    });
  }, [cave, ambDay, wind]);

  const enterForest = useCallback(() => {
    if (phase !== 'title') return;
    setPhase('opening');
    cave.seekTo(0); cave.play();
    setMouthFrame(1);
    setTimeout(() => setMouthFrame(2), FRAME_MS);
    setTimeout(zoomIn, FRAME_MS * 2);
  }, [phase, cave, zoomIn]);

  const startWalk = useCallback(() => { walkingRef.current = true; setIsWalking(true); }, []);
  const stopWalk = useCallback(() => { walkingRef.current = false; setIsWalking(false); }, []);

  const leaveForest = useCallback(() => {
    for (const p of [ambDay, ambNight, wind, stream, steps]) p.pause();
    setPhase('ending');
  }, [ambDay, ambNight, wind, stream, steps]);

  const backToTitle = useCallback(() => {
    setMouthFrame(0);
    zoom.setValue(1);
    curtain.setValue(0);
    setSpeech(null);
    speechRef.current = null;
    setPhase('title');
  }, [zoom, curtain]);

  useEffect(() => {
    if (phase !== 'walking') return undefined;
    let raf;
    let last = Date.now();

    const frame = () => {
      const now = Date.now();
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      if (walkingRef.current) {
        spawnInRef.current -= dt;
        if (spawnInRef.current <= 0 && itemsRef.current.length < MAX_ALIVE) {
          spawnInRef.current = SPAWN_EVERY * (0.6 + Math.random());
          const m = pick(MUSHROOMS);
          itemsRef.current.push({
            key: `m${seqRef.current++}`,
            type: m.type,
            src: m.src,
            wx: (Math.random() < 0.5 ? -1 : 1) * (PATH_CLEAR + (1 - PATH_CLEAR) * Math.random()) * SPREAD,
            z: -walkedRef.current - Z_FAR, 
            spoke: false,
          });
        }
        
        itemsRef.current = itemsRef.current.filter((it) => it.z < -walkedRef.current + Z_NEAR);

        setPower((p) => Math.max(0, p - dt * 0.005));

        const progress = walkedRef.current / exitAtRef.current;
        const next = Math.min(SCENES.length - 1, Math.floor(progress * SCENES.length));
        setSceneIndex((cur) => (cur === next ? cur : next));

        const hasWater = SCENES[next].water;
        if (hasWater && !stream.playing) stream.play();
        else if (!hasWater && stream.playing) stream.pause();

        if (progress > 0.75 && !nightRef.current) {
          nightRef.current = true;
          setIsNight(true);
          ambDay.pause();
          ambNight.seekTo(0);
          ambNight.play();
        }

        if (walkedRef.current >= exitAtRef.current) {
          stopWalk();
          setPhase('exit');
        }
      }
      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [phase, say, ambDay, ambNight, stream]);

  useEffect(() => {
    if (isWalking && phase === 'walking') {
      if (!steps.playing) steps.play();
    } else {
      if (steps.playing) steps.pause();
    }
  }, [isWalking, phase, steps]);

  const { x: mX, y: mY, size: mSize } = mouthOnScreen();
  const handW = mSize * 0.18;
  const handH = handW * 1.5;

  return (
    <View style={styles.container}>
      
      {(phase === 'walking' || phase === 'exit') && (
        <View style={styles.canvasContainer}>
          <Canvas camera={{ position: [0, 0.5, 0], fov: 60 }}>
            <WorldScene 
              isWalking={isWalking} 
              walkedRef={walkedRef} 
              itemsRef={itemsRef}
              sceneIndex={sceneIndex}
              phase={phase}
              isNight={isNight}
              power={power}
              onSpeak={say}
            />
          </Canvas>
        </View>
      )}

      {speech && (
        <View pointerEvents="none" style={styles.speech}>
          <Text style={styles.speechText}>{speech}</Text>
        </View>
      )}

      {phase === 'walking' && (
        <TouchableOpacity style={styles.fill} activeOpacity={1} onPressIn={stopWalk} onPressOut={startWalk} />
      )}

      {phase === 'exit' && (
        <TouchableOpacity style={styles.fill} activeOpacity={1} onPress={leaveForest}>
          <View style={[styles.fill, { justifyContent: 'center', alignItems: 'center' }]}>
            <Text style={styles.titleText}>タップして森を抜ける</Text>
          </View>
        </TouchableOpacity>
      )}

      {phase === 'ending' && (
        <View style={[styles.fill, { backgroundColor: '#fff', justifyContent: 'center', alignItems: 'center' }]}>
          <Image source={require('./assets/char_welcome.png')} style={{ width: 300, height: 300, marginBottom: 40 }} resizeMode="contain" />
          <Text style={styles.titleText}>きのこの森を抜けました</Text>
          <TouchableOpacity onPress={backToTitle} style={{ marginTop: 40 }}>
            <Text style={styles.speechText}>もう一度</Text>
          </TouchableOpacity>
        </View>
      )}

      {(phase === 'title' || phase === 'opening') && (
        <View style={styles.fill}>
          <Animated.View style={[
            styles.fill,
            {
              transform: [
                { translateX: zoom.interpolate({ inputRange: [1, 12], outputRange: [0, SCREEN_WIDTH / 2 - mX] }) },
                { translateY: zoom.interpolate({ inputRange: [1, 12], outputRange: [0, SCREEN_HEIGHT / 2 - mY] }) },
                { scale: zoom }
              ]
            }
          ]}>
            <Image source={TITLE_FRAMES[mouthFrame]} style={styles.fill} resizeMode="contain" />
          </Animated.View>

          {phase === 'title' && (
            <Animated.View pointerEvents="none" style={{
              position: 'absolute',
              left: mX - handW * 0.7,
              top: mY + handW * 0.1,
              width: handW,
              height: handH,
              opacity: tapOpacity,
              transform: [{ rotate: `${HAND_TILT}deg` }]
            }}>
              <Image source={require('./assets/tap_hand.png')} style={styles.fill} resizeMode="contain" />
            </Animated.View>
          )}
          
          <TouchableOpacity style={styles.fill} activeOpacity={1} onPress={enterForest}>
            <View style={[styles.fill, { justifyContent: 'flex-start', alignItems: 'center', paddingTop: 80 }]}>
            </View>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  fill: { position: 'absolute', width: '100%', height: '100%' },
  canvasContainer: { position: 'absolute', width: '100%', height: '100%' },
  titleText: { fontSize: 32, fontWeight: '900', color: '#333', letterSpacing: 4 },
  speech: {
    position: 'absolute',
    left: 24, right: 24, bottom: 120,
    backgroundColor: 'rgba(250,248,240,0.93)',
    padding: 24,
    borderRadius: 16,
    borderWidth: 1, borderColor: 'rgba(200,190,170,0.5)',
  },
  speechText: { fontSize: 20, color: '#3a3a3a', lineHeight: 32, fontWeight: '500' },
});
