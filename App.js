import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';

import LINES from './mushroomLines.json';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// --- 森の見え方 -------------------------------------------------------------
// 奥行き z が Z_FAR から減っていき、Z_NEAR を切ったら通り過ぎたものとして消す。
// 画面上の大きさは FOCAL / z。z = FOCAL のとき等倍になる。
const Z_FAR = 100;
const Z_NEAR = 15;
const FOCAL = 15;
// 森の写真は、道が画面の 68% あたりで消えている。ここを地平線として扱う。
// ここがずれると、キノコが地面から浮いて宙に生えているように見える。
// 画面の大きさに対する割合で決める。固定pxだと機種によって別物になる
const BASE_SIZE = SCREEN_HEIGHT * 0.42;   // すぐ横を通るときの一辺
const GROUND = SCREEN_HEIGHT * 0.32;      // 地平線から足元までの落差
const SPREAD = SCREEN_WIDTH * 0.42;       // 道の左右への広がり
const PATH_CLEAR = 0.38;                  // 道の中央のこの範囲には生やさない

const WALK_SPEED = 18;       // 1秒あたり z がどれだけ減るか
const SPAWN_EVERY = 1.1;     // 何秒に1体出すか
const MAX_ALIVE = 6;
const SPEAK_AT = 42;         // この距離まで近づいたら声を掛けてくる

const POWER_STEP = 0.018;    // すれ違い1回ぶんの明るさ
const POWER_MAX = 0.25;      // 上限。無制限だと白飛びする

const EXIT_MIN = 120;        // 出口までの歩行時間（秒）。毎回変わる
const EXIT_MAX = 300;

// 歩くにつれてこの順に移り変わる（新しい森画像）
const SCENES = [
  { src: require('./assets/bg_forest_0.png'), water: false, horizon: 0.68 },
  { src: require('./assets/bg_forest_1.png'), water: false, horizon: 0.68 },
  { src: require('./assets/bg_forest_2.png'), water: false, horizon: 0.68 },
  { src: require('./assets/bg_forest_3.png'), water: false, horizon: 0.68 },
  { src: require('./assets/bg_forest_4.png'), water: true, horizon: 0.68 },
  { src: require('./assets/bg_forest_5.png'), water: false, horizon: 0.68 },
  { src: require('./assets/bg_forest_6.png'), water: false, horizon: 0.68 },
  { src: require('./assets/bg_forest_7.png'), water: false, horizon: 0.68 },
];

// タイトルの口。閉じる→少し開く→大きく開く を1枚ずつ見せてから寄る
const FRAME_MS = 180;        // 1枚を見せる時間（遅すぎるとカクついて不自然になるため短縮）
const ZOOM_MAX = 4.2;        // 寄りすぎると口が判別できなくなる
const TITLE_W = 1080;
const TITLE_H = 764;
const MOUTH_X = 0.502;       // 画像に対する口の位置（実測値）
// 閉じた口の位置。開いた口との差分で測ると「穴の中心」＝もっと下を指してしまう。
// title_1_closed.png の顔の中央で、横に走るいちばん暗い行を探して出した値
const MOUTH_Y = 0.6296;

// 手の大きさは、画面ではなく「表示されているタイトル画の幅」に対して決める。
// 固定pxにすると、画像が小さく表示されるスマホで手だけ巨大になる
const HAND_RATIO = 0.075;
const HAND_TILT = 28;        // 右へ傾ける角度
// 画像の指先はおよそ (0.42, 0.12)。中心まわりに HAND_TILT だけ回すと
// (0.25, 0.20) に移るので、その位置が口に来るよう置く
const TIP_DX = 0.251;
const TIP_DY = 0.202;
// 左手なので口の左下から指す。指先を口の真下ではなく、少し左下に置く
const HAND_OFF_X = 0.85;
const HAND_OFF_Y = 0.15;

/** contain で表示したときの、口の画面上の位置を出す。 */
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

const TITLE_FRAMES = [
  require('./assets/title_1_closed.png'),
  require('./assets/title_2_open.png'),
  require('./assets/title_3_wide.png'),
];

// type は mushroomLines.json のキーと対応している（セリフをそのまま流用するため既存のtypeを割り当て）
const MUSHROOMS = [
  { type: 'shiitake', src: require('./assets/char_mushroom_1.png') },
  { type: 'king_oyster', src: require('./assets/char_mushroom_2.png') },
  { type: 'nameko', src: require('./assets/char_mushroom_3.png') },
  { type: 'matsutake', src: require('./assets/char_mushroom_4.png') },
  { type: 'black_truffle', src: require('./assets/char_mushroom_5.png') },
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** そのキノコが言うことば。固有のことばと共通のことばを混ぜて選ぶ。 */
function lineFor(type, isNight) {
  const own = LINES[type]?.lines || [];
  const c = LINES.common || {};
  // 夜は落ち着いたことば、昼は明るいことばを多めにする
  const pool = isNight
    ? [...(c.heal || []), ...(c.heal || []), ...(c.cheer || []), ...(c.funny || [])]
    : [...(c.cheer || []), ...(c.cheer || []), ...(c.heal || []), ...(c.funny || [])];
  return pick([...own, ...own, ...pool]);
}

/** ことばの長さに合わせて表示時間を決める。固定だと長い文が読み終わらない。 */
const readingTime = (text) => 1500 + text.length * 120;

export default function App() {
  const [phase, setPhase] = useState('title');  // title | opening | walking | exit | ending
  const [mouthFrame, setMouthFrame] = useState(0);
  const [isNight, setIsNight] = useState(false);
  const [isWalking, setIsWalking] = useState(false);
  const [sceneIndex, setSceneIndex] = useState(0);
  const [speech, setSpeech] = useState(null);
  const [power, setPower] = useState(0);        // きのこパワー = 森の明るさ

  const itemsRef = useRef([]);
  const [, redraw] = useReducer((n) => n + 1, 0);

  const walkingRef = useRef(false);
  const walkedRef = useRef(0);
  const spawnInRef = useRef(1);
  const exitAtRef = useRef(EXIT_MIN);
  const seqRef = useRef(0);
  const nightRef = useRef(false);
  const speechRef = useRef(null);   // 表示中は次を出さない
  const speechTimer = useRef(null);

  // 空間を漂う光の粒（前進感＝オプティカルフローを生むため）
  const dustRef = useRef(Array.from({ length: 30 }).map(() => ({
    wx: (Math.random() - 0.5) * SPREAD * 4,
    wy: (Math.random() - 0.8) * SCREEN_HEIGHT * 1.5,
    z: Math.random() * Z_FAR,
  })));

  const bob = useRef(new Animated.Value(0)).current;
  const tapBounce = useRef(new Animated.Value(0)).current;
  const zoom = useRef(new Animated.Value(1)).current;
  const curtain = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => { nightRef.current = isNight; }, [isNight]);

  // --- 音 -------------------------------------------------------------------
  const ambDay = useAudioPlayer(require('./assets/audio/amb_mountain1.mp3'));
  const ambNight = useAudioPlayer(require('./assets/audio/amb_night.mp3'));
  const wind = useAudioPlayer(require('./assets/audio/amb_wind1.mp3'));
  const stream = useAudioPlayer(require('./assets/audio/amb_stream.mp3'));
  const steps = useAudioPlayer(require('./assets/audio/step_soil.mp3'));
  const cave = useAudioPlayer(require('./assets/audio/amb_cave.mp3'));

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false });
    for (const [p, v] of [[ambDay, 0.5], [ambNight, 0.55], [wind, 0.3], [stream, 0], [steps, 0.85]]) {
      p.loop = true;
      p.volume = v;
    }
    cave.volume = 0.55;
  }, [ambDay, ambNight, wind, stream, steps, cave]);

  useEffect(() => {
    if (phase !== 'walking') return;
    if (isNight) { ambDay.pause(); ambNight.play(); }
    else { ambNight.pause(); ambDay.play(); }
  }, [isNight, phase, ambDay, ambNight]);

  // 水辺の場面でだけ渓流の音を混ぜる
  useEffect(() => {
    stream.volume = SCENES[sceneIndex]?.water ? 0.45 : 0;
  }, [sceneIndex, stream]);

  useEffect(() => {
    if (phase !== 'walking' || !isWalking) steps.pause();
    else steps.play();
  }, [isWalking, phase, steps]);

  // タップを促す指の上下
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(tapBounce, { toValue: 1, duration: 620, useNativeDriver: true }),
        Animated.timing(tapBounce, { toValue: 0, duration: 620, useNativeDriver: true }),
      ])
    ).start();
  }, [tapBounce]);

  // 菌糸の明滅
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 3200, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 3200, useNativeDriver: true }),
      ])
    ).start();
  }, [pulse]);

  // 歩行中の上下の揺れ
  useEffect(() => {
    if (!isWalking) {
      bob.stopAnimation();
      Animated.timing(bob, { toValue: 0, duration: 300, useNativeDriver: true }).start();
      return;
    }
    Animated.loop(
      Animated.sequence([
        Animated.timing(bob, { toValue: 1, duration: 420, useNativeDriver: true }),
        Animated.timing(bob, { toValue: 0, duration: 420, useNativeDriver: true }),
      ])
    ).start();
  }, [isWalking, bob]);

  const say = useCallback((item) => {
    const text = lineFor(item.type, nightRef.current);
    speechRef.current = text;
    setSpeech(text);
    setPower((p) => Math.min(POWER_MAX, p + POWER_STEP));
    if (speechTimer.current) clearTimeout(speechTimer.current);
    speechTimer.current = setTimeout(() => {
      speechRef.current = null;
      setSpeech(null);
    }, readingTime(text));
  }, []);

  // --- タイトル：口が開いて、吸い込まれる -----------------------------------
  const zoomIn = useCallback(() => {
    Animated.parallel([
      Animated.timing(zoom, { toValue: ZOOM_MAX, duration: 1400, useNativeDriver: true }),
      // curtain は幕を上げるときに JS 側で動かすので、こちらも揃える。
      // 同じ値にネイティブ駆動とJS駆動を混ぜると実行時に落ちる
      Animated.timing(curtain, { toValue: 1, duration: 1400, useNativeDriver: false }),
    ]).start(() => {
      // 森に入った瞬間、すでにいくつかキノコが生えている状態を作る（最初は空っぽで不自然だったのを修正）
      const initialItems = [];
      let seq = 0;
      for (let i = 0; i < 4; i++) {
        const m = pick(MUSHROOMS);
        initialItems.push({
          key: `m${seq++}`,
          type: m.type,
          src: m.src,
          wx: (Math.random() < 0.5 ? -1 : 1) * (PATH_CLEAR + (1 - PATH_CLEAR) * Math.random()) * SPREAD,
          z: Z_NEAR + 10 + Math.random() * (Z_FAR - Z_NEAR - 20),
          spoke: false,
        });
      }
      // 遠い順にソートしておく
      initialItems.sort((a, b) => b.z - a.z);

      itemsRef.current = initialItems;
      walkedRef.current = 0;
      spawnInRef.current = SPAWN_EVERY;
      seqRef.current = seq;
      exitAtRef.current = EXIT_MIN + Math.random() * (EXIT_MAX - EXIT_MIN);
      setPower(0);
      setSceneIndex(0);
      setSpeech(null);
      speechRef.current = null;
      setPhase('walking');
      // 幕を上げるのは森の画面が出てから（下の useEffect）。
      // ここで動かすと、消えるタイトル画面の幕に対して動いてしまい、
      // 新しく出た森の画面の幕が真っ黒のまま取り残される
      (nightRef.current ? ambNight : ambDay).play();
      wind.play();
    });
  }, [zoom, curtain, ambDay, ambNight, wind]);

  // 森の画面が出てから幕を上げる
  useEffect(() => {
    if (phase !== 'walking') return;
    curtain.setValue(1);
    Animated.timing(curtain, { toValue: 0, duration: 900, useNativeDriver: false }).start();
  }, [phase, curtain]);

  const enterForest = useCallback(() => {
    if (phase !== 'title') return;
    setPhase('opening');
    cave.seekTo(0);
    cave.play();

    // 口が開くところを1枚ずつ見せてから寄る
    setMouthFrame(1);
    setTimeout(() => setMouthFrame(2), FRAME_MS);
    setTimeout(zoomIn, FRAME_MS * 2);
  }, [phase, cave, zoomIn]);

  // --- 歩く -----------------------------------------------------------------
  useEffect(() => {
    if (phase !== 'walking') return undefined;
    let raf;
    let last = Date.now();

    const frame = () => {
      const now = Date.now();
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      if (walkingRef.current) {
        walkedRef.current += dt;

        for (const it of itemsRef.current) {
          it.z -= WALK_SPEED * dt;
          // 近づいたら声を掛けてくる。一体につき一度だけ、重ならないように
          if (!it.spoke && it.z <= SPEAK_AT) {
            it.spoke = true;
            if (!speechRef.current) say(it);
          }
        }
        itemsRef.current = itemsRef.current.filter((it) => it.z > Z_NEAR);

        spawnInRef.current -= dt;
        if (spawnInRef.current <= 0 && itemsRef.current.length < MAX_ALIVE) {
          spawnInRef.current = SPAWN_EVERY * (0.6 + Math.random());
          const m = pick(MUSHROOMS);
          itemsRef.current.push({
            key: `m${seqRef.current++}`,
            type: m.type,
            src: m.src,
            // 道の真ん中には生えない。道端に、左右どちらかに寄せて生やす
            wx: (Math.random() < 0.5 ? -1 : 1)
              * (PATH_CLEAR + (1 - PATH_CLEAR) * Math.random()) * SPREAD,
            z: Z_FAR,
            spoke: false,
          });
        }

        // 光の粒の更新（前進感を強調するため少し速く動かす）
        for (const d of dustRef.current) {
          d.z -= WALK_SPEED * dt * 1.5;
          if (d.z < 2) {
            d.z = Z_FAR;
            d.wx = (Math.random() - 0.5) * SPREAD * 4;
            d.wy = (Math.random() - 0.8) * SCREEN_HEIGHT * 1.5;
          }
        }

        const progress = walkedRef.current / exitAtRef.current;
        const next = Math.min(SCENES.length - 1, Math.floor(progress * SCENES.length));
        setSceneIndex((cur) => (cur === next ? cur : next));

        if (walkedRef.current >= exitAtRef.current) {
          walkingRef.current = false;
          setIsWalking(false);
          setPhase('exit');
        }
        redraw();
      }
      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [phase, say]);

  useEffect(() => () => { if (speechTimer.current) clearTimeout(speechTimer.current); }, []);

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

  // --- 描画 -----------------------------------------------------------------
  if (phase === 'title' || phase === 'opening') {
    const mouth = mouthOnScreen();
    const handW = mouth.size * HAND_RATIO;   // 表示されている画像の幅に合わせる
    // 口は画像中心より下にある。拡大は中心基準なので、その分だけ持ち上げる
    const lift = zoom.interpolate({
      inputRange: [1, ZOOM_MAX],
      outputRange: [0, -(mouth.y - SCREEN_HEIGHT / 2) * (ZOOM_MAX - 1)],
    });
    return (
      // タイトル画は白背景の絵。縦長の画面だと上下に余白が出るので、
      // 画面の地色も白にして絵と地続きに見せる
      <View style={styles.paper}>
        <TouchableOpacity activeOpacity={1} style={styles.fill} onPress={enterForest}>
          <Animated.Image
            source={TITLE_FRAMES[mouthFrame]}
            style={[styles.fill, { transform: [{ translateY: lift }, { scale: zoom }] }]}
            resizeMode="contain"
          />
          {phase === 'title' && (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.tapMark,
                {
                  width: handW,
                  left: mouth.x - handW * (TIP_DX + HAND_OFF_X),
                  top: mouth.y + handW * (HAND_OFF_Y - TIP_DY),
                  transform: [
                    { translateY: tapBounce.interpolate({ inputRange: [0, 1], outputRange: [0, 9] }) },
                  ],
                },
              ]}
            >
              <Image
                source={require('./assets/tap_hand.png')}
                style={{ width: handW, height: handW, transform: [{ rotate: `${HAND_TILT}deg` }] }}
                resizeMode="contain"
              />
              <Text style={styles.tapText}>TAP</Text>
            </Animated.View>
          )}
        </TouchableOpacity>
        <Animated.View pointerEvents="none" style={[styles.curtain, { opacity: curtain }]} />
      </View>
    );
  }

  if (phase === 'ending') {
    return (
      <View style={styles.paper}>
        <Image source={require('./assets/ending_okaeri.png')} style={styles.fill} resizeMode="contain" />
        <TouchableOpacity style={styles.againBtn} onPress={backToTitle} activeOpacity={0.7}>
          <Text style={styles.againText}>また、山へ</Text>
        </TouchableOpacity>
      </View>
    );
  }
  
  const totalWalk = exitAtRef.current || 1;
  const progress = Math.max(0, walkedRef.current / totalWalk);
  const localProgress = phase === 'walking' ? (progress * SCENES.length) % 1 : 0;
  // 背景がパン（首振り）しても端が見えないように 1.15 倍スタートにする
  const bgScale = 1.15 + (localProgress * 0.15);

  const bobY = bob.interpolate({ inputRange: [0, 1], outputRange: [0, 14] });
  const glow = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: isNight ? [0.45, 0.9] : [0.08, 0.18],
  });
  const nightAlpha = Math.max(0, 0.72 - power * 1.6);

  const timeSec = Date.now() / 1000; // 呼吸と揺れのための時間

  // --- 3D視差（パララックス）と首振り（パン）の計算 ---
  // 目線が1点に固定されないよう、ゆっくり首を振る
  const panX = Math.sin(timeSec * 0.4) * 35; 
  const panY = Math.sin(timeSec * 0.25) * 15;
  const currentCx = (SCREEN_WIDTH / 2) + panX;
  const currentHorizon = phase === 'exit' ? 0.68 : SCENES[sceneIndex].horizon;
  const currentCy = (SCREEN_HEIGHT * currentHorizon) + panY;

  // 歩行に合わせて体が左右に揺れる（遠くの背景より手前のキノコが大きく動く＝視差）
  const swayPhase = walkedRef.current * 1.2;
  const cameraTranslateX = Math.sin(swayPhase) * 45;

  // Web専用の環境光ブレンド（周囲の森の色味にキノコをなじませる）
  // 昼は少し彩度を落として暖色を足し、夜は暗くして青みを足す
  const envFilter = isNight 
    ? 'brightness(0.55) contrast(1.1) sepia(0.4) hue-rotate(180deg)' 
    : 'brightness(0.9) contrast(1.15) sepia(0.25) saturate(0.85)';

  const drawn = itemsRef.current.map((it) => {
    const scale = FOCAL / it.z;
    // 遠く(Z_FAR)から現れるとき、幽霊のように透けるのではなく、
    // 地面から「ニョキッ」と生える（急成長する）ようにサイズを絞る
    const sprout = Math.min(1, Math.max(0, (Z_FAR - it.z) / 20));
    const size = BASE_SIZE * scale * sprout;
    
    // 生命感（呼吸と揺れ）を計算
    // キノコごとに動きをずらすため it.wx を位相に使う
    const breathe = 1.0 + Math.sin(timeSec * 2 + it.wx) * 0.03; 
    const sway = Math.sin(timeSec * 1.5 + it.wx) * 3; // ±3度の揺れ

    // パララックスを適用した画面座標
    const screenX = currentCx + (it.wx - cameraTranslateX) * scale;
    const screenY = currentCy + GROUND * scale;

    return { it, size, x: screenX, y: screenY, breathe, sway, sprout };
  });

  // 前進感を生む光の粒
  const drawnDust = dustRef.current.map((d, i) => {
    if (d.z <= 0) return null;
    const scale = FOCAL / d.z;
    const screenX = currentCx + (d.wx - cameraTranslateX) * scale;
    const screenY = currentCy + d.wy * scale;
    const size = Math.max(2, 5 * scale);
    let opacity = 1;
    if (d.z > Z_FAR - 20) opacity = (Z_FAR - d.z) / 20; // 遠くでフェードイン
    if (d.z < 10) opacity = d.z / 10; // 手前でフェードアウト
    
    return (
      <View key={`dust${i}`} pointerEvents="none" style={{
        position: 'absolute', left: screenX, top: screenY, width: size, height: size,
        backgroundColor: isNight ? 'rgba(150, 220, 255, 0.6)' : 'rgba(255, 240, 150, 0.6)',
        borderRadius: size, opacity,
        boxShadow: `0 0 ${size}px rgba(255,255,255,0.8)` // 光彩
      }} />
    );
  });

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.fill, { transform: [{ translateY: bobY }] }]}>
        <Image
          source={phase === 'exit' ? require('./assets/bg_exit.png') : SCENES[sceneIndex].src}
          style={[styles.fill, { transform: [{ scale: bgScale }, { translateX: panX }, { translateY: panY }] }]}
          resizeMode="cover"
        />

        {isNight && <View pointerEvents="none" style={[styles.night, { opacity: nightAlpha }]} />}
        {!isNight && power > 0 && (
          <View pointerEvents="none" style={[styles.shine, { opacity: power * 0.7 }]} />
        )}

        {/* 光の粒を描画 */}
        {phase === 'walking' && drawnDust}
      </Animated.View>

      {speech && (
        <View pointerEvents="none" style={styles.speech}>
          <Text style={styles.speechText}>{speech}</Text>
        </View>
      )}

      {/* キノコは手前に描画し、セリフ枠に足元が隠れないようにする */}
      <Animated.View pointerEvents="none" style={[styles.fill, { transform: [{ translateY: bobY }] }]}>
        {phase === 'walking' && drawn.map(({ it, size, x, y, breathe, sway, sprout }) => (
          <View
            key={it.key}
            pointerEvents="none"
            style={{ position: 'absolute', left: x - size / 2, top: y - size, width: size, height: size }}
          >
            {/* 足元の影（接地感を出す） */}
            <View
              style={{
                position: 'absolute',
                left: size * 0.25,
                top: size * 0.88,
                width: size * 0.5,
                height: size * 0.15,
                backgroundColor: 'rgba(0,20,10,0.6)',
                borderRadius: size * 0.25,
                // 遠くにあるほど影も薄くする
                opacity: sprout,
              }}
            />
            <Animated.Image
              source={require('./assets/mycelium.png')}
              style={{
                position: 'absolute',
                left: -size * 0.5,
                top: -size * 0.1,
                width: size * 2,
                height: size * 2,
                opacity: glow,
              }}
              resizeMode="contain"
            />
            {/* キノコ本体に呼吸と揺れ、環境光フィルターを適用 */}
            <Image 
              source={it.src} 
              style={[
                styles.fill, 
                { 
                  transform: [{ scaleY: breathe }, { rotate: `${sway}deg` }],
                  filter: envFilter,
                }
              ]} 
              resizeMode="contain" 
            />
          </View>
        ))}
      </Animated.View>

      {phase === 'walking' && (
        <View
          style={styles.fill}
          onStartShouldSetResponder={() => true}
          onResponderGrant={startWalk}
          onResponderRelease={stopWalk}
          onResponderTerminate={stopWalk}
        >
        </View>
      )}

      {phase === 'exit' && (
        <TouchableOpacity style={styles.fill} activeOpacity={1} onPress={leaveForest}>
          <Text style={styles.exitHint}>森の出口。くぐる</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity style={styles.dayNight} onPress={() => setIsNight((v) => !v)} activeOpacity={0.7}>
        <Text style={{ fontSize: 22 }}>{isNight ? '🌙' : '🌞'}</Text>
      </TouchableOpacity>

      <Animated.View pointerEvents="none" style={[styles.curtain, { opacity: curtain }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0d09' },
  paper: { flex: 1, backgroundColor: '#ffffff' },
  // width/height を省くと react-native-web で大きさが決まらず、何も描かれない
  fill: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' },
  night: { ...StyleSheet.absoluteFillObject, backgroundColor: '#050a19' },
  shine: { ...StyleSheet.absoluteFillObject, backgroundColor: '#fff6d8' },
  curtain: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },

  tapMark: { position: 'absolute', alignItems: 'center' },
  tapText: {
    marginTop: 4,
    color: 'rgba(58,50,40,0.9)',
    fontSize: 16,
    letterSpacing: 4,
    fontWeight: '600',
    // キノコの根元の暗い部分に重なっても読めるように
    textShadowColor: 'rgba(255,255,255,0.95)',
    textShadowRadius: 5,
  },
  hint: {
    position: 'absolute',
    bottom: 54,
    alignSelf: 'center',
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    letterSpacing: 1,
    textShadowColor: '#000',
    textShadowRadius: 4,
  },
  exitHint: {
    position: 'absolute',
    bottom: 70,
    alignSelf: 'center',
    color: 'rgba(255,255,255,0.85)',
    fontSize: 16,
    letterSpacing: 3,
    textShadowColor: '#000',
    textShadowRadius: 6,
  },
  speech: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 120,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderRadius: 20,
    backgroundColor: 'rgba(250,248,240,0.93)',
    zIndex: 60,
  },
  speechText: { color: '#2c2a24', fontSize: 18, lineHeight: 26, textAlign: 'center' },
  dayNight: {
    position: 'absolute',
    top: 48,
    right: 22,
    padding: 8,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.25)',
    zIndex: 70,
  },
  againBtn: {
    position: 'absolute',
    bottom: 56,
    alignSelf: 'center',
    paddingVertical: 12,
    paddingHorizontal: 34,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: 'rgba(70,60,45,0.45)',
  },
  againText: { color: '#4a4034', fontSize: 16, letterSpacing: 3 },
});
