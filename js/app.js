/* ============================================================
   APP — 状态 / 界面 / 播放调度 / 工作台
   ============================================================ */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };

  function fmtTime(t) {
    t = Math.max(0, t || 0);
    var m = Math.floor(t / 60);
    var s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }
  var HTML_MAP = { '&': 38, '<': 60, '>': 62, '"': 34, "'": 39 };
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return '&#' + HTML_MAP[c] + ';';
    });
  }

  var PALETTE = ['#ff5fb8', '#43e7ff', '#5cffb1', '#a06bff', '#ffe66d',
    '#ff9a62', '#7cffcb', '#ff5d8f', '#9d8cff', '#63f5ef', '#ffb3e6', '#c8ff5e'];

  /* ---------------- DOM ---------------- */
  var el = {
    play: document.getElementById('btnPlay'),
    stop: document.getElementById('btnStop'),
    exp: document.getElementById('btnExport'),
    clockCur: document.getElementById('clockCur'),
    clockDur: document.getElementById('clockDur'),
    masterVol: document.getElementById('masterVol'),
    viz: document.getElementById('viz'),
    rollTag: document.getElementById('rollTag'),
    vizCur: document.getElementById('vizCur'),
    te: document.getElementById('te'),
    teNum: document.getElementById('teNum'),
    teDot: document.getElementById('teDot'),
    teName: document.getElementById('teName'),
    teSel: document.getElementById('teSel'),
    teVol: document.getElementById('teVol'),
    teMute: document.getElementById('teMute'),
    teSolo: document.getElementById('teSolo'),
    teInfo: document.getElementById('teInfo'),
    teClose: document.getElementById('teClose'),
    piano: document.getElementById('piano'),
    teScroll: document.getElementById('teScroll'),
    teScrollWrap: document.getElementById('teScrollWrap'),
    trackList: document.getElementById('trackList'),
    sampleList: document.getElementById('sampleList'),
    fileMidi: document.getElementById('fileMidi'),
    fileMp3: document.getElementById('fileMp3'),
    wb: document.getElementById('wb'),
    wbName: document.getElementById('wbName'),
    wbSel: document.getElementById('wbSel'),
    wbOps: document.getElementById('wbOps'),
    wbFx: document.getElementById('wbFx'),
    wbApply: document.getElementById('wbApply'),
    wbPreview: document.getElementById('wbPreview'),
    wbClose: document.getElementById('wbClose'),
    wbRevert: document.getElementById('wbRevert'),
    wbUndo: document.getElementById('wbUndo'),
    wave: document.getElementById('wave'),
    picker: document.getElementById('picker'),
    pkList: document.getElementById('pkList'),
    pkClose: document.getElementById('pkClose'),
    wbDelete: document.getElementById('wbDelete'),
    wbRate: document.getElementById('wbRate'),
    wbRateVal: document.getElementById('wbRateVal'),
    toast: document.getElementById('toast')
  };

  /* ---------------- 状态 ---------------- */
  var S = {
    ctx: null,
    master: null,
    limiter: null,
    tracks: [],
    samples: [],
    midiName: '',
    duration: 0,
    cursor: 0,
    playing: false,
    startCtx: 0,
    startMusic: 0,
    nodes: new Set(),
    activeTrack: -1,
    rollDirty: true
  };
  var uid = 0;

  /* ---------------- toast ---------------- */
  var toastT = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(function () { el.toast.classList.remove('show'); }, 1500);
  }

  /* ---------------- 音频图 ---------------- */
  function ac() {
    if (!S.ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      S.ctx = new AC();
      AU.ctxRef = S.ctx;
      S.master = S.ctx.createGain();
      S.master.gain.value = parseFloat(el.masterVol.value);
      S.limiter = S.ctx.createDynamicsCompressor();
      S.limiter.threshold.value = -6;
      S.limiter.knee.value = 8;
      S.limiter.ratio.value = 6;
      S.limiter.attack.value = 0.004;
      S.limiter.release.value = 0.18;
      S.master.connect(S.limiter);
      S.analyser = S.ctx.createAnalyser();
      S.analyser.fftSize = 1024;
      S.analyser.smoothingTimeConstant = 0.72;
      S.limiter.connect(S.analyser);
      S.analyser.connect(S.ctx.destination);
      S.freqData = new Uint8Array(S.analyser.frequencyBinCount);
      S.timeData = new Uint8Array(S.analyser.fftSize);
      S.peakHold = new Float32Array(64);
    }
    if (S.ctx.state === 'suspended') S.ctx.resume();
    return S.ctx;
  }

  /* ---------------- 播放调度 ---------------- */
  function scheduleNote(ctx, n, sm, dest, t0, from, collect) {
    var buf = sm.buffer;
    var ratio = Math.pow(2, (n.pitch - sm.base) / 12) * (sm.rate || 1);
    var startMusic = n.start > from ? n.start : from;
    if (startMusic >= n.end) return;
    var skip = startMusic - n.start;
    var when = t0 + (startMusic - from);
    if (ctx.currentTime && when < ctx.currentTime - 0.22) return;
    var dur = n.end - startMusic;
    if (dur < 0.012) dur = 0.012;

    var off = skip * ratio;
    if (off >= buf.duration) return;

    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = ratio;

    var avail = buf.duration - off;
    var bufDur = Math.min(dur * ratio, avail);
    if (bufDur <= 0.001) return;

    var realDur = Math.min(dur, bufDur / ratio);
    if (realDur < 0.012) realDur = 0.012;

    var g = ctx.createGain();
    var peak = Math.pow(clamp(n.vel, 1, 127) / 127, 1.15) * 0.78;
    var atk = Math.min(0.008, realDur * 0.3);
    var rel = Math.min(0.07, realDur * 0.5);
    var sus = Math.max(atk, realDur - rel);

    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + atk);
    g.gain.setValueAtTime(peak, when + sus);
    g.gain.linearRampToValueAtTime(0, when + realDur);

    src.connect(g);
    g.connect(dest);

    try { src.start(when, off, Math.min(bufDur, realDur * ratio + 0.012)); } catch (e) { return; }

    if (collect) {
      S.nodes.add(src);
      src.onended = function () {
        try { g.disconnect(); } catch (e) { }
        try { src.disconnect(); } catch (e) { }
        S.nodes.delete(src);
      };
    }
  }

  function stopNodes() {
    if (!S.nodes) return;
    S.nodes.forEach(function (n) {
      try { n.stop(0); } catch (e) { }
      try { n.disconnect(); } catch (e) { }
    });
    S.nodes.clear();
  }

  /* 未绑定采样时的内置音色：三角波 + 八度正弦，短促的拨弦包络 */
  function synthNote(ctx, n, dest, t0, from, collect) {
    var startMusic = n.start > from ? n.start : from;
    if (startMusic >= n.end) return;
    var when = t0 + (startMusic - from);
    if (ctx.currentTime && when < ctx.currentTime - 0.22) return;
    var dur = n.end - startMusic;
    if (dur < 0.03) dur = 0.03;

    var f = MIDI.midiToFreq(n.pitch);
    if (!isFinite(f) || f <= 0) return;

    var g = ctx.createGain();
    var peak = Math.pow(clamp(n.vel, 1, 127) / 127, 1.15) * 0.26;
    var atk = Math.min(0.008, dur * 0.3);
    var rel = Math.min(0.07, dur * 0.55);

    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + atk);
    g.gain.setValueAtTime(peak, when + Math.max(atk, dur - rel));
    g.gain.linearRampToValueAtTime(0, when + dur);

    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(7000, f * 7 + 900);
    lp.Q.value = 0.7;
    g.connect(lp);
    lp.connect(dest);

    var o1 = ctx.createOscillator();
    o1.type = 'triangle';
    o1.frequency.value = f;
    var o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = f * 2.004;
    var g2 = ctx.createGain();
    g2.gain.value = 0.32;

    o1.connect(g);
    o2.connect(g2);
    g2.connect(g);

    var end = when + dur + 0.02;
    try {
      o1.start(when); o2.start(when);
      o1.stop(end); o2.stop(end);
    } catch (e) { return; }

    if (collect) {
      S.nodes.add(o1);
    S.nodes.add(o2);
      o1.onended = function () {
        try { g.disconnect(); } catch (e) { }
        try { o1.disconnect(); } catch (e) { }
        try { o2.disconnect(); } catch (e) { }
      };
    }
  }

  /* 把选中的文件 POST 上传到服务器 media/，供下次直接选用 */
  function uploadToServer(file) {
    var name = file.name || ('upload_' + Date.now());
    return fetch('./upload?name=' + encodeURIComponent(name), {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' }
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (info) {
      return info;
    }).catch(function (e) {
      console.warn('[upload]', e);
      return null;
    });
  }

  /* 文件读取 / 解码兼容层 */
  function readFile(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error); };
      fr.readAsArrayBuffer(file);
    });
  }

  function decodeAudio(ctx, ab) {
    return new Promise(function (res, rej) {
      var p = ctx.decodeAudioData(ab, res, rej);
      if (p && typeof p.then === 'function') p.then(res, rej);
    });
  }

  function startPlayback(from) {
    if (!S.tracks.length) { toast('NO MIDI'); return; }
    var ctx = ac();
    stopNodes();

    var t0 = ctx.currentTime + 0.07;
    S.startCtx = t0;
    S.startMusic = from;
    S.playing = true;
    S.trackGain = [];
    S.trackIdx = [];

    var anySolo = S.tracks.some(function (t) { return t.solo; });
    for (var i = 0; i < S.tracks.length; i++) {
      var t = S.tracks[i];
      var g = ctx.createGain();
      g.gain.value = t.gain;
      g.connect(S.master);
      S.nodes.add(g);

      var audible = !t.mute && !(anySolo && !t.solo);
      S.trackGain[i] = audible ? g : null;

      var idx = 0;
      while (idx < t.notes.length && t.notes[idx].start < from) idx++;
      S.trackIdx[i] = idx;
    }

    S.nextSched = 0;
    schedNotes();
    if (S.schedTimer) clearInterval(S.schedTimer);
    S.schedTimer = setInterval(function () {
      if (!S.playing) return;
      try { schedNotes(); } catch (e) { }
    }, 80);
    setPlayingUI(true);
  }

  /* 滚动调度：只把未来 1.5s 内的音符塞进音频图，音符上万也不卡 */
  function schedNotes() {
    if (!S.playing || !S.ctx) return;
    var ctx = S.ctx;
    var musicNow = S.startMusic + (ctx.currentTime - S.startCtx);
    var budget = 700;
    var target = musicNow + 2.5;

    for (var i = 0; i < S.tracks.length; i++) {
      var t = S.tracks[i];
      var idx = S.trackIdx[i] || 0;
      var g = S.trackGain[i];
      var sm = null;
      if (g && t.sampleId) {
        for (var k = 0; k < S.samples.length; k++) {
          if (S.samples[k].id === t.sampleId) { sm = S.samples[k]; break; }
        }
      }

      var gs = sm ? null : gmSampleFor(t);

      while (idx < t.notes.length && t.notes[idx].start < target) {
        if (budget <= 0) break;
        var n = t.notes[idx];
        if (n.end > musicNow && g) {
          budget -= 2;
          if (sm) scheduleNote(ctx, n, sm, g, S.startCtx, S.startMusic, true);
          else if (gs) scheduleNote(ctx, n, gs, g, S.startCtx, S.startMusic, true);
          else synthNote(ctx, n, g, S.startCtx, S.startMusic, true);
        }
        idx++;
      }
      S.trackIdx[i] = idx;
    }
  }

  function stopPlayback(keepCursor) {
    if (S.schedTimer) { clearInterval(S.schedTimer); S.schedTimer = null; }
    stopNodes();
    S.playing = false;
    S.trackGain = [];
    S.trackIdx = [];
    if (!keepCursor) S.cursor = 0;
    setPlayingUI(false);
  }

  /* 播放中改音量 / 静音 / 独奏，立刻生效 */
  function applyTrackGains() {
    if (!S.trackGain) return;
    var anySolo = false;
    for (var i = 0; i < S.tracks.length; i++) if (S.tracks[i].solo) { anySolo = true; break; }
    for (var j = 0; j < S.tracks.length; j++) {
      var g = S.trackGain[j];
      if (!g) continue;
      var t = S.tracks[j];
      g.gain.value = (!t.mute && !(anySolo && !t.solo)) ? t.gain : 0;
    }
  }

  function setPlayingUI(on) {
    el.play.textContent = on ? '❚❚' : '▶';
    el.play.classList.toggle('on', on);
  }

  function togglePlay() {
    if (S.playing) {
      stopPlayback(true);
    } else {
      if (S.duration && S.cursor >= S.duration - 0.02) S.cursor = 0;
      startPlayback(S.cursor);
    }
  }

  /* ---------------- 导出 ---------------- */
  async function exportWav() {
    if (!S.tracks.length) { toast('NO MIDI'); return; }
    toast('RENDER');
    var sr = S.duration > 180 ? 22050 : 44100;
    var dur = S.duration + 1.5;
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var oc = new OAC(2, Math.ceil(dur * sr), sr);
    var mg = oc.createGain();
    mg.gain.value = parseFloat(el.masterVol.value);
    var lim = oc.createDynamicsCompressor();
    lim.threshold.value = -8; lim.knee.value = 8; lim.ratio.value = 9;
    lim.attack.value = 0.004; lim.release.value = 0.18;
    mg.connect(lim); lim.connect(oc.destination);

    var anySolo = S.tracks.some(function (t) { return t.solo; });
    for (var i = 0; i < S.tracks.length; i++) {
      var t = S.tracks[i];
      if (t.mute) continue;
      if (anySolo && !t.solo) continue;
      var sm = null;
      for (var k = 0; k < S.samples.length; k++) if (S.samples[k].id === t.sampleId) { sm = S.samples[k]; break; }
      if (!sm) continue;
      var g = oc.createGain();
      g.gain.value = t.gain;
      g.connect(mg);
      var gs2 = sm ? null : gmSampleFor(t);
      for (var j = 0; j < t.notes.length; j++) {
        if (sm) scheduleNote(oc, t.notes[j], sm, g, 0.02, 0, false);
        else if (gs2) scheduleNote(oc, t.notes[j], gs2, g, 0.02, 0, false);
        else synthNote(oc, t.notes[j], g, 0.02, 0, false);
      }
    }

    try {
      var out = await oc.startRendering();
      var blob = AU.encodeWav(out);
      var name = (S.midiName.replace(/\.[^.]+$/, '') || 'mad') + '.wav';
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 3000);
      toast('WAV · ' + (blob.size / 1048576).toFixed(1) + 'MB');
    } catch (e) {
      console.error(e);
      toast('RENDER FAIL');
    }
  }

  /* ---------------- MIDI ---------------- */
  function applyMidi(data, name) {
    if (!data.tracks.length) { toast('NO NOTES'); return; }
    var firstSample = null;
    S.tracks = data.tracks.map(function (t, i) {
      return {
        name: t.name,
        color: PALETTE[i % PALETTE.length],
        notes: t.notes,
        program: t.program,
        sampleId: firstSample,
        gain: 1.0,
        mute: false,
        solo: false
      };
    });
    S.duration = Math.max(data.duration, 0.4);
    S.cursor = 0;
    S.midiName = name;
    S.activeTrack = -1;
    el.rollTag.textContent = name.replace(/\.[^.]+$/, '').toUpperCase();
    renderTracks();
    S.rollDirty = true;
    toast(data.tracks.length + ' TRACKS · ' + fmtTime(S.duration));
  }

  async function loadMidi(file) {
    try {
      uploadToServer(file);
      var buf = await readFile(file);
      applyMidi(MIDI.parse(buf), file.name);
    } catch (e) {
      console.error(e);
      toast('MIDI ERROR');
    }
  }

  /* ---------------- 采样 ---------------- */
  var VIDEO_RE = /\.(mp4|m4v|mov|mkv|webm|avi|flv|3gp|ts|wmv)$/i;

  async function loadAudioFiles(files) {
    var ctx = ac();
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var fromVideo = VIDEO_RE.test(f.name) || /^video\//.test(f.type || '');
      try {
        uploadToServer(f);
        var ab = await readFile(f);
        var buf = await decodeAudio(ctx, ab);
        addSample(f.name.replace(/\.[^.]+$/, ''), buf, fromVideo);
      } catch (e) {
        console.error(e);
        /* 解码器不支持这个容器/编码时，退回媒体元素实时抓取前 5 秒 */
        try {
          var grabbed = await grabFromElement(f, fromVideo);
          addSample(f.name.replace(/\.[^.]+$/, ''), grabbed, fromVideo);
          toast('已抓取前 5 秒');
        } catch (e2) {
          console.error(e2);
          toast(fromVideo ? '视频无音轨' : '解码失败');
        }
      }
    }
  }

  /* 用 <video>/<audio> 播放，ScriptProcessor 抓 PCM —— 兜住 decodeAudioData 解不了的文件 */
  function grabFromElement(file, isVideo) {
    return new Promise(function (resolve, reject) {
      var ctx = ac();
      if (ctx.state === 'suspended') ctx.resume();

      var url = URL.createObjectURL(file);
      var el2 = document.createElement(isVideo ? 'video' : 'audio');
      el2.src = url;
      el2.preload = 'auto';
      el2.playsInline = true;
      el2.muted = false;

      var srcNode = null, proc = null, silent = null;
      var chunkL = [], chunkR = [], total = 0;
      var sr = ctx.sampleRate;
      var MAX = sr * 5;
      var finished = false;
      var timer = null;

      function clean() {
        try { el2.pause(); } catch (e) { }
        try { el2.removeAttribute('src'); el2.load(); } catch (e) { }
        try { if (proc) proc.disconnect(); } catch (e) { }
        try { if (srcNode) srcNode.disconnect(); } catch (e) { }
        try { if (silent) silent.disconnect(); } catch (e) { }
        try { URL.revokeObjectURL(url); } catch (e) { }
        if (timer) clearTimeout(timer);
      }

      function done(ok) {
        if (finished) return;
        finished = true;
        clean();
        if (!ok || total < sr * 0.2) { reject(new Error('no audio')); return; }
        var buf = AU.makeBuffer(2, total, sr);
        var srcs = [chunkL, chunkR];
        for (var ch = 0; ch < 2; ch++) {
          var d = buf.getChannelData(ch);
          var off = 0;
          for (var i = 0; i < srcs[ch].length; i++) {
            d.set(srcs[ch][i], off);
            off += srcs[ch][i].length;
          }
        }
        resolve(buf);
      }

      try {
        srcNode = ctx.createMediaElementSource(el2);
        proc = ctx.createScriptProcessor(4096, 2, 2);
        silent = ctx.createGain();
        silent.gain.value = 0;
      } catch (e) {
        clean();
        reject(e);
        return;
      }

      proc.onaudioprocess = function (ev) {
        if (finished) return;
        var l = ev.inputBuffer.getChannelData(0);
        var r = ev.inputBuffer.numberOfChannels > 1 ? ev.inputBuffer.getChannelData(1) : l;
        chunkL.push(new Float32Array(l));
        chunkR.push(new Float32Array(r));
        total += l.length;
        if (total >= MAX) done(true);
      };

      srcNode.connect(proc);
      proc.connect(silent);
      silent.connect(ctx.destination);

      el2.onerror = function () { done(false); };
      el2.onloadedmetadata = function () {
        if (!isFinite(el2.duration)) { done(false); return; }
        var p = el2.play();
        if (p && p.catch) p.catch(function () { done(false); });
      };

      timer = setTimeout(function () { done(true); }, 12000);
    });
  }

  /* 不区分投到哪个入口，按内容自动路由 */
  function routeFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    var mids = [], rest = [];
    list.forEach(function (f) {
      if (/\.(mid|midi|smf|kar)$/i.test(f.name)) mids.push(f);
      else rest.push(f);
    });
    if (mids.length) loadMidi(mids[0]);
    if (rest.length) loadAudioFiles(rest);
  }

  /* ---------------- 内置 GM 音色（FluidR3 真采样） ---------------- */
  var GM = {
    piano: { name: '钢琴', file: 'acoustic_grand_piano', bases: [36, 60, 84], buf: {}, ready: false },
    guitar: { name: '吉他', file: 'electric_guitar_clean', bases: [36, 60, 84], buf: {}, ready: false },
    bass: { name: '贝斯', file: 'electric_bass_finger', bases: [36, 60, 84], buf: {}, ready: false },
    strings: { name: '弦乐', file: 'string_ensemble_1', bases: [36, 60, 84], buf: {}, ready: false }
  };
  var GM_PATH = 'media/gm/';

  function gmKeyOf(program) {
    var p = program || 0;
    if (p >= 24 && p <= 31) return 'guitar';
    if (p >= 32 && p <= 39) return 'bass';
    if (p >= 40 && p <= 55) return 'strings';
    return 'piano';
  }

  function loadGM() {
    var ctx;
    try { ctx = ac(); } catch (e) { return; }
    Object.keys(GM).forEach(function (k) {
      var inst = GM[k];
      var pending = inst.bases.length;
      var ok = 0;
      inst.bases.forEach(function (b) {
        var note = MIDI.noteName(b);
        fetch(GM_PATH + inst.file + '_' + note + '.mp3')
          .then(function (r) { if (!r.ok) throw new Error('404'); return r.arrayBuffer(); })
          .then(function (ab) { return decodeAudio(ctx, ab); })
          .then(function (buf) {
            try { buf = AU.trimHead(buf, 0.006); } catch (e) { }
            try { buf = AU.normalize(buf, 0.95); } catch (e) { }
            inst.buf[b] = buf;
            ok++;
          })
          .catch(function () { })
          .then(function () {
            pending--;
            if (pending === 0) {
              if (ok > 0) { inst.ready = true; renderTracks(); }
            }
          });
      });
    });
  }

  /* 为一条轨选最近的 GM 基音采样 */
  function gmSampleFor(t) {
    var key = gmKeyOf(t.program);
    var inst = GM[key];
    if (!inst || !inst.ready) return null;
    if (t._gmKey === key && t._gmBase != null && inst.buf[t._gmBase]) {
      return { buffer: inst.buf[t._gmBase], base: t._gmBase };
    }
    var n = t.notes;
    var mid = 60;
    if (n && n.length) mid = n[Math.floor(n.length / 2)].pitch;
    var best = inst.bases[0], bd = 1e9;
    for (var i = 0; i < inst.bases.length; i++) {
      if (!inst.buf[inst.bases[i]]) continue;
      var d = Math.abs(inst.bases[i] - mid);
      if (d < bd) { bd = d; best = inst.bases[i]; }
    }
    if (!inst.buf[best]) return null;
    t._gmKey = key;
    t._gmBase = best;
    return { buffer: inst.buf[best], base: best };
  }

  function sourceName(t) {
    var sn = sampleNameOf(t);
    if (sn) return { name: sn, gm: false };
    var inst = GM[gmKeyOf(t.program)];
    if (inst && inst.ready) return { name: inst.name, gm: true };
    return { name: '合成', gm: false };
  }

  function addSample(name, buffer, fromVideo) {
    if (!buffer || !buffer.length || buffer.duration < 0.05) {
      toast('音频为空');
      return;
    }
    var base = 60;
    var det = AU.detectPitch(buffer);
    if (det > 0) base = Math.round(clamp(det, 21, 108));

    var s = {
      id: 's' + (uid++),
      name: name,
      buffer: buffer,
      orig: buffer,
      base: base,
      peaks: AU.peaks(buffer, 72)
    };
    S.samples.push(s);

    renderSamples();
    renderTracks();
    toast((fromVideo ? '音轨 · ' : '') + name.slice(0, 14).toUpperCase() + ' · ' + MIDI.noteName(base));
  }

  function renderSamples() {
    var host = el.sampleList;
    host.innerHTML = '';
    if (!S.samples.length) {
      host.innerHTML = '<div class="empty">—</div>';
      return;
    }
    S.samples.forEach(function (s) {
      var d = document.createElement('div');
      d.className = 'sample';
      d.dataset.id = s.id;

      var cv = document.createElement('canvas');
      d.appendChild(cv);

      var info = document.createElement('div');
      info.className = 'sinfo';
      info.innerHTML = '<div class="sname">' + esc(s.name) + '</div>' +
        '<div class="smeta">' + s.buffer.duration.toFixed(2) + 's · ' + MIDI.noteName(s.base) + (s.rate && s.rate !== 1 ? ' · ' + s.rate.toFixed(2) + 'x' : '') + '</div>';
      d.appendChild(info);

      var b = document.createElement('button');
      b.className = 'sbtn';
      b.textContent = 'EDIT';
      d.appendChild(b);

      host.appendChild(d);
      drawMini(cv, s);
    });
  }

  function drawMini(cv, s) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = cv.clientWidth || 58, h = cv.clientHeight || 26;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    var peaks = s.peaks;
    var n = peaks.length;
    for (var i = 0; i < w; i++) {
      var idx = Math.floor(i / w * n);
      var v = peaks[idx] || 0;
      var hh = Math.max(1, v * (h - 4));
      g.fillStyle = v > 0.5 ? '#ff5fb8' : 'rgba(67,231,255,.85)';
      g.fillRect(i, (h - hh) / 2, 1, hh);
    }
  }

  function previewBuffer(buf) {
    var ctx = ac();
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(S.master);
    src.start();
    S.nodes.add(src);
    src.onended = function () { S.nodes.delete(src); };
  }

  /* ---------------- 轨道列表 ---------------- */
  /* 轨道行的迷你预览：按时间档的音符密度 */
  function drawTrackMini(cv, t) {
    if (!cv) return;
    var w = cv.clientWidth || 40;
    var h = cv.clientHeight || 14;
    if (w < 2) w = 40;
    if (h < 2) h = 14;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    var notes = t.notes;
    if (!notes || !notes.length) return;
    var total = Math.max(S.duration, 0.1);
    var cols = Math.max(8, Math.round(w));
    var counts = new Float32Array(cols);
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      var c0 = Math.floor((n.start / total) * cols);
      var c1 = Math.ceil((n.end / total) * cols);
      if (c1 <= c0) c1 = c0 + 1;
      for (var c = c0; c < c1; c++) {
        if (c >= 0 && c < cols) counts[c] += 1;
      }
    }
    var maxC = 1;
    for (var j = 0; j < cols; j++) if (counts[j] > maxC) maxC = counts[j];
    var cw = w / cols;
    g.fillStyle = t.color;
    for (var k = 0; k < cols; k++) {
      var v = counts[k] / maxC;
      if (v <= 0) continue;
      var hh = Math.max(1.5, v * (h - 2));
      g.globalAlpha = 0.28 + v * 0.66;
      g.fillRect(k * cw, h - hh - 1, Math.max(1, cw - 0.4), hh);
    }
    g.globalAlpha = 1;
  }

  function sampleNameOf(t) {
    if (!t || !t.sampleId) return '';
    for (var i = 0; i < S.samples.length; i++) {
      if (S.samples[i].id === t.sampleId) return S.samples[i].name;
    }
    return '';
  }

  function renderTracks() {
    var host = el.trackList;
    host.innerHTML = '';
    if (!S.tracks.length) {
      host.innerHTML = '<div class="empty">—</div>';
      return;
    }
    S.tracks.forEach(function (t, i) {
      var d = document.createElement('div');
      d.className = 'trow' + (TE && TE.idx === i && el.te.classList.contains('open') ? ' active' : '');
      d.style.setProperty('--c', t.color);
      d.dataset.i = i;
      var src = sourceName(t);
      var sn = src.name;
      d.innerHTML =
        '<span class="trow-idx">' + pad2(i + 1) + '</span>' +
        '<span class="trow-name">' + esc(t.name) + '</span>' +
        '<canvas class="trow-mini"></canvas>' +
        '<span class="trow-smp' + (src.gm ? ' gm' : '') + '">' + esc(sn) + '</span>' +
        '<span class="trow-n">' + t.notes.length + '</span>' +
        '<button class="ms' + (t.mute ? ' on' : '') + '" data-act="mute">M</button>' +
        '<button class="ms solo' + (t.solo ? ' on' : '') + '" data-act="solo">S</button>' +
        '<span class="trow-arrow">›</span>';
      host.appendChild(d);
      drawTrackMini(d.querySelector('.trow-mini'), t);
    });
  }

  el.trackList.addEventListener('click', function (e) {
    var card = e.target.closest('.trow');
    if (!card) return;
    var i = +card.dataset.i;
    var t = S.tracks[i];
    if (!t) return;
    var act = e.target.getAttribute && e.target.getAttribute('data-act');
    if (act === 'mute') {
      t.mute = !t.mute;
      e.target.classList.toggle('on', t.mute);
      applyTrackGains();
      return;
    }
    if (act === 'solo') {
      t.solo = !t.solo;
      e.target.classList.toggle('on', t.solo);
      applyTrackGains();
      return;
    }
    openTrackEditor(i);
  });

  el.sampleList.addEventListener('click', function (e) {
    var card = e.target.closest('.sample');
    if (!card) return;
    var s = null;
    for (var i = 0; i < S.samples.length; i++) {
      if (S.samples[i].id === card.dataset.id) { s = S.samples[i]; break; }
    }
    if (!s) return;
    if (e.target.closest('.sbtn')) { openWorkbench(s); return; }
    card.classList.add('playing');
    setTimeout(function () { card.classList.remove('playing'); },
      Math.min(1400, s.buffer.duration * 1000));
    previewBuffer(s.buffer);
  });

/* ---------------- 音频可视化 ---------------- */
  var vizCtx = null, vizW = 0, vizH = 0;
  var VIZ_BARS = 48;

  function fitViz() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var rect = el.viz.getBoundingClientRect();
    vizW = Math.max(1, Math.round(rect.width));
    vizH = Math.max(1, Math.round(rect.height));
    el.viz.width = Math.round(vizW * dpr);
    el.viz.height = Math.round(vizH * dpr);
    vizCtx = el.viz.getContext('2d');
    vizCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

/* 陷日地平线背景（预渲染，只在尺寸变化时重建） */
var bgCv = null, bgKey = '';

function ensureVizBg(W, H) {
  var key = Math.round(W) + 'x' + Math.round(H);
  if (bgCv && bgKey === key) return bgCv;

  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(W * dpr));
  c.height = Math.max(1, Math.round(H * dpr));
  var g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  var hy = H * 0.74;

  var sky = g.createLinearGradient(0, 0, 0, hy);
  sky.addColorStop(0, 'rgba(26,6,40,0)');
  sky.addColorStop(0.55, 'rgba(118,22,84,0.26)');
  sky.addColorStop(1, 'rgba(255,95,184,0.34)');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, hy);

  var cx = W / 2;
  var cy = hy + H * 0.015;
  var r = Math.min(W * 0.62, H * 0.92);
  var sun = g.createLinearGradient(0, cy - r, 0, cy + r);
  sun.addColorStop(0, 'rgba(255,246,180,0.95)');
  sun.addColorStop(0.30, 'rgba(255,182,92,0.92)');
  sun.addColorStop(0.62, 'rgba(255,95,184,0.82)');
  sun.addColorStop(1, 'rgba(160,107,255,0.55)');
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fillStyle = sun;
  g.fill();

  g.save();
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.clip();
  g.fillStyle = 'rgba(8,2,14,0.40)';
  var step = Math.max(9, H * 0.032);
  for (var sy = cy - r; sy < cy + r; sy += step) {
    var t = (sy - (cy - r)) / (2 * r);
    g.fillRect(cx - r, sy, r * 2, step * (0.16 + t * 0.46));
  }
  g.restore();

  g.fillStyle = 'rgba(4,1,9,0.94)';
  g.fillRect(0, hy, W, H - hy);

  g.strokeStyle = 'rgba(255,95,184,0.20)';
  g.lineWidth = 1;
  for (var i = 1; i <= 5; i++) {
    var yy = hy + Math.pow(i / 5, 2) * (H - hy);
    g.beginPath(); g.moveTo(0, yy + .5); g.lineTo(W, yy + .5); g.stroke();
  }
  for (var v = -5; v <= 5; v++) {
    g.beginPath();
    g.moveTo(cx + v * (W / 10) * 0.25, hy);
    g.lineTo(cx + v * (W / 10) * 2.2, H);
    g.stroke();
  }

  g.fillStyle = 'rgba(255,140,200,0.85)';
  g.fillRect(0, hy, W, 1);

  bgCv = c;
  bgKey = key;
  return c;
}

var lastVizT = 0;

function drawViz() {
    if (!vizCtx) return;
    var now = performance.now();
    if (now - lastVizT < 30) return;
    lastVizT = now;
    var W = vizW, H = vizH, g = vizCtx, t = now;
    g.clearRect(0, 0, W, H);
    var bgImg = ensureVizBg(W, H);
    g.drawImage(bgImg, 0, 0, W, H);

    var baseY = H - 7;

    g.lineWidth = 1;
    g.strokeStyle = 'rgba(92,255,177,.05)';
    for (var r = 1; r < 6; r++) {
      var gy = H * r / 6;
      g.beginPath(); g.moveTo(0, gy + .5); g.lineTo(W, gy + .5); g.stroke();
    }

    var mag = 0;
    if (S.analyser && S.freqData) {
      S.analyser.getByteFrequencyData(S.freqData);
      for (var k = 0; k < S.freqData.length; k++) if (S.freqData[k] > mag) mag = S.freqData[k];
    }
    var idle = mag < 4;

    var N = 80;
    var xs = [], ys = [];
    for (var i = 0; i < N; i++) {
      var v;
      if (idle) {
        v = (Math.sin(i * 0.24 + t * 0.0015) * 0.5 + 0.5) * 0.045 + 0.012;
      } else {
        var f0 = Math.floor(Math.pow(i / N, 1.7) * (S.freqData.length * 0.72));
        var f1 = Math.max(f0 + 1, Math.floor(Math.pow((i + 1) / N, 1.7) * (S.freqData.length * 0.72)));
        var sum = 0, cnt = 0;
        for (var q = f0; q < f1 && q < S.freqData.length; q++) { sum += S.freqData[q]; cnt++; }
        v = Math.pow((cnt ? sum / cnt : 0) / 255, 0.85);
      }
      xs.push((i / (N - 1)) * W);
      ys.push(baseY - v * (H * 0.84));
    }

    var grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, idle ? 'rgba(92,255,177,.045)' : 'rgba(92,255,177,.20)');
    grad.addColorStop(1, 'rgba(92,255,177,0)');
    g.beginPath();
    g.moveTo(0, baseY);
    for (var a = 0; a < N; a++) g.lineTo(xs[a], ys[a]);
    g.lineTo(W, baseY);
    g.closePath();
    g.fillStyle = grad;
    g.fill();

    function trace(color, width, alpha) {
      g.globalAlpha = alpha;
      g.strokeStyle = color;
      g.lineWidth = width;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.beginPath();
      for (var p = 0; p < N; p++) {
        if (p === 0) g.moveTo(xs[p], ys[p]);
        else g.lineTo(xs[p], ys[p]);
      }
      g.stroke();
      g.globalAlpha = 1;
    }

    trace('#39ff9e', 3.4, idle ? 0.05 : 0.14);
    trace('#5cffb1', 1.7, idle ? 0.11 : 0.42);
    trace('#8affd2', 0.9, idle ? 0.16 : 0.95);

    g.fillStyle = 'rgba(92,255,177,.14)';
    g.fillRect(0, baseY, W, 1);
    if (S.duration > 0) {
      var px = (S.cursor / S.duration) * W;
      g.fillStyle = 'rgba(124,255,196,.9)';
      g.fillRect(0, baseY - 1, px, 2);
    }
  }

  /* ---------------- 定位 ---------------- */
  var seekDrag = false;
  function seekAt(clientX) {
    if (!S.duration) return;
    var rect = el.viz.getBoundingClientRect();
    var x = clamp(clientX - rect.left, 0, rect.width);
    var t = (x / rect.width) * S.duration;
    if (S.playing) {
      stopPlayback(true);
      S.cursor = t;
      startPlayback(t);
    } else {
      S.cursor = t;
    }
    updateClock();
  }
  el.viz.addEventListener('pointerdown', function (e) {
    seekDrag = true;
    try { el.viz.setPointerCapture(e.pointerId); } catch (err) { }
    seekAt(e.clientX);
  });
  el.viz.addEventListener('pointermove', function (e) {
    if (seekDrag) seekAt(e.clientX);
  });
  el.viz.addEventListener('pointerup', function () { seekDrag = false; });
  el.viz.addEventListener('pointercancel', function () { seekDrag = false; });

  /* ============================================================
     轨道详情编辑（单轨 MIDI 编辑）
     ============================================================ */

  var TE = {
    idx: -1,
    sel: -1,
    drag: null,
    hist: [],
    range: null,
    zoom: 1,
    pan: 0,
    grid: 16,
    pinch: null,
    viewStart: 0,
    viewSpan: 1,
    lastTap: 0,
    lastTapIdx: -1
  };

  var pCtx = null, pW = 0, pH = 0;

  function fitPiano() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var rect = el.piano.getBoundingClientRect();
    pW = Math.max(1, Math.round(rect.width));
    pH = Math.max(1, Math.round(rect.height));
    el.piano.width = Math.round(pW * dpr);
    el.piano.height = Math.round(pH * dpr);
    pCtx = el.piano.getContext('2d');
    pCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function clampT(v) {
    if (!isFinite(v)) return 0;
    return v < 0 ? 0 : (v > 900 ? 900 : v);
  }

  function teRange() {
    var t = S.tracks[TE.idx];
    if (!t) return { t1: 1, lo: 48, hi: 72 };
    var maxT = 0, lo = 127, hi = 0;
    for (var i = 0; i < t.notes.length; i++) {
      var n = t.notes[i];
      if (isFinite(n.end) && n.end > maxT) maxT = n.end;
      if (n.pitch < lo) lo = n.pitch;
      if (n.pitch > hi) hi = n.pitch;
    }
    if (!t.notes.length) { lo = 60; hi = 72; }
    if (!isFinite(maxT) || maxT <= 0) maxT = 1;
    lo -= 2; hi += 2;
    if (hi - lo < 10) { var m = (hi + lo) / 2; lo = Math.round(m - 5); hi = lo + 10; }
    if (hi > 127) hi = 127;
    if (lo < 0) lo = 0;
    return { t1: Math.min(maxT, 900), lo: lo, hi: hi };
  }

  function drawPiano() {
    if (!pCtx) return;
    var W = pW, H = pH, g = pCtx;
    if (W < 2 || H < 2) return;
    g.clearRect(0, 0, W, H);

    var t = S.tracks[TE.idx];
    if (!t) return;

    var R = teRange();
    TE.range = R;
    var rows = R.hi - R.lo;
    if (rows <= 0 || !isFinite(R.t1) || R.t1 <= 0) return;
    var rowH = H / rows;

    var total = R.t1;
    var span = total / TE.zoom;
    if (!isFinite(span) || span <= 0) span = total;
    if (span > total) span = total;
    var start = TE.pan * (total - span);
    if (!isFinite(start) || start < 0) start = 0;
    TE.viewStart = start;
    TE.viewSpan = span;
    var sx = W / span;

    // 黑白键底纹
    for (var i = 0; i < rows; i++) {
      var p = R.hi - 1 - i;
      var m = ((p % 12) + 12) % 12;
      if (m === 1 || m === 3 || m === 6 || m === 8 || m === 10) {
        g.fillStyle = 'rgba(255,255,255,.023)';
        g.fillRect(0, i * rowH, W, rowH);
      }
      if (m === 0) {
        g.strokeStyle = 'rgba(255,95,184,.15)';
        g.beginPath(); g.moveTo(0, i * rowH + .5); g.lineTo(W, i * rowH + .5); g.stroke();
      }
    }

    // 节拍线
    var beat = S.beatSec || 0.5;
    if (!(beat > 0.001)) beat = 0.5;
    var b0 = Math.floor(start / beat);
    for (var b = b0, guard = 0; guard < 4000; b++, guard++) {
      var x = (b * beat - start) * sx;
      if (x > W) break;
      if (x < -1) continue;
      g.strokeStyle = (b % 4 === 0) ? 'rgba(67,231,255,.16)' : 'rgba(255,255,255,.05)';
      g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, H); g.stroke();
    }

    // 音符
    for (var k = 0; k < t.notes.length; k++) {
      var n = t.notes[k];
      var nx = (n.start - start) * sx;
      var nw = Math.max(2.5, (n.end - n.start) * sx);
      if (nx > W || nx + nw < 0) continue;
      var ny = (R.hi - 1 - n.pitch) * rowH;
      var nh = Math.max(2.5, rowH - 1.5);
      var on = (k === TE.sel);

      g.globalAlpha = on ? 1 : 0.85;
      g.fillStyle = on ? '#ffffff' : t.color;
      g.fillRect(nx, ny + 0.75, nw, nh);

      g.globalAlpha = 1;
      if (on) {
        g.strokeStyle = '#ff5fb8';
        g.lineWidth = 1.5;
        g.strokeRect(nx + .75, ny + 1.5, nw - 1.5, nh - 1.5);
        g.fillStyle = '#ff5fb8';
        g.fillRect(nx + nw - 3, ny + 0.75, 2, nh);
      }
    }
  }

  function hitTest(px, py) {
    var t = S.tracks[TE.idx];
    var R = TE.range || teRange();
    if (!t) return { i: -1, mode: 'none' };
    if (pW < 2 || pH < 2 || !isFinite(R.t1) || R.t1 <= 0) return { i: -1, mode: 'none' };
    var rows = R.hi - R.lo;
    if (rows <= 0) return { i: -1, mode: 'none' };
    var rowH = pH / rows;
    var span = TE.viewSpan || R.t1;
    var start = TE.viewStart || 0;
    var sx = pW / span;

    for (var i = t.notes.length - 1; i >= 0; i--) {
      var n = t.notes[i];
      var x = (n.start - start) * sx;
      var w = Math.max(2.5, (n.end - n.start) * sx);
      var y = (R.hi - 1 - n.pitch) * rowH;
      if (px >= x - 3 && px <= x + w + 3 && py >= y - 1 && py <= y + rowH + 1) {
        var edgeW = w > 16 ? 9 : w * 0.35;
        return { i: i, mode: (px > x + w - edgeW) ? 'len' : 'move' };
      }
    }
    var pitch = R.hi - 1 - Math.floor(py / rowH);
    var time = start + (px / pW) * span;
    return { i: -1, mode: 'new', pitch: pitch, time: time };
  }

  function updateTeInfo() {
    var t = S.tracks[TE.idx];
    if (!t) { el.teInfo.textContent = '—'; return; }
    var bpm = S.beatSec ? Math.round(60 / S.beatSec) : 120;
    el.teInfo.textContent = t.notes.length + ' 音符 · ' + bpm + ' BPM'
      + (TE.sel >= 0 && t.notes[TE.sel] ? ' · ' + MIDI.noteName(t.notes[TE.sel].pitch) : '');
  }

  function recalcDuration() {
    var d = 0;
    for (var i = 0; i < S.tracks.length; i++) {
      var ns = S.tracks[i].notes;
      for (var j = 0; j < ns.length; j++) {
        if (isFinite(ns[j].end) && ns[j].end > d) d = ns[j].end;
      }
    }
    if (!isFinite(d) || d < 0) d = 0;
    S.duration = Math.max(d, 0.4);
  }

  function tePush() {
    var t = S.tracks[TE.idx];
    if (!t) return;
    TE.hist.push(JSON.stringify(t.notes));
    if (TE.hist.length > 30) TE.hist.shift();
  }

  function snapNote(n) {
    var grid = noteGrid();
    if (grid < 0.02) return;
    if (!isFinite(n.start) || !isFinite(n.end)) return;
    n.start = Math.max(0, Math.round(n.start / grid) * grid);
    var e = Math.round(n.end / grid) * grid;
    if (e <= n.start) e = n.start + grid;
    n.end = e;
  }

  function teCommit() {
    var t = S.tracks[TE.idx];
    if (!t) return;
    var selNote = (TE.sel >= 0 && t.notes[TE.sel]) ? t.notes[TE.sel] : null;
    t.notes.sort(function (a, b) { return a.start - b.start; });
    TE.sel = selNote ? t.notes.indexOf(selNote) : -1;

    recalcDuration();
    drawPiano();
    updateTeInfo();

    var row = el.trackList.children[TE.idx];
    if (row) {
      var nEl = row.querySelector('.trow-n');
      if (nEl) nEl.textContent = t.notes.length;
    }

    if (S.playing) {
      var cur = S.cursor;
      stopPlayback(true);
      S.cursor = cur;
      startPlayback(cur);
    }
  }

  function openTrackEditor(i) {
    var t = S.tracks[i];
    if (!t) return;
    TE.idx = i;
    TE.sel = -1;
    TE.hist = [];
    TE.drag = null;
    TE.zoom = 1;
    TE.pan = 0;
    if (el.teScrollWrap) el.teScrollWrap.classList.remove('on');

    el.teNum.textContent = pad2(i + 1);
    el.teDot.style.background = t.color;
    el.te.style.setProperty('--c', t.color);
    el.teName.value = t.name;

    var opts = '<option value="">—</option>';
    for (var s = 0; s < S.samples.length; s++) {
      var sm = S.samples[s];
      opts += '<option value="' + sm.id + '"' + (sm.id === t.sampleId ? ' selected' : '') + '>' +
        esc(sm.name) + '</option>';
    }
    el.teSel.innerHTML = opts;
    el.teVol.value = t.gain;
    el.teMute.classList.toggle('on', t.mute);
    el.teSolo.classList.toggle('on', t.solo);

    el.te.classList.add('open');
    teSyncToolUI();
    renderTracks();
    requestAnimationFrame(function () {
      fitPiano();
      drawPiano();
      updateTeInfo();
    });
  }

  function closeTrackEditor() {
    el.te.classList.remove('open');
    TE.drag = null;
    TE.idx = -1;
    TE.sel = -1;
    renderTracks();
  }

  el.teClose.addEventListener('click', closeTrackEditor);

  el.teName.addEventListener('input', function () {
    var t = S.tracks[TE.idx];
    if (!t) return;
    t.name = el.teName.value;
    var row = el.trackList.children[TE.idx];
    if (row) {
      var e2 = row.querySelector('.trow-name');
      if (e2) e2.textContent = t.name;
    }
  });

  el.teSel.addEventListener('change', function () {
    var t = S.tracks[TE.idx];
    if (!t) return;
    t.sampleId = el.teSel.value || null;
    renderTracks();
  });

  el.teVol.addEventListener('input', function () {
    var t = S.tracks[TE.idx];
    if (!t) return;
    t.gain = parseFloat(el.teVol.value);
    applyTrackGains();
  });

  el.teMute.addEventListener('click', function () {
    var t = S.tracks[TE.idx];
    if (!t) return;
    t.mute = !t.mute;
    el.teMute.classList.toggle('on', t.mute);
    applyTrackGains();
    renderTracks();
  });

  el.teSolo.addEventListener('click', function () {
    var t = S.tracks[TE.idx];
    if (!t) return;
    t.solo = !t.solo;
    el.teSolo.classList.toggle('on', t.solo);
    applyTrackGains();
    renderTracks();
  });

  /* ---- 工具条 ---- */
  el.te.querySelector('.te-tools').addEventListener('click', function (e) {
    var b = e.target.closest('.tool');
    if (!b) return;
    teTool(b.getAttribute('data-act'));
  });

  function teTool(act) {
    var t = S.tracks[TE.idx];
    if (!t) return;

    if (act === 'undo') {
      if (!TE.hist.length) { toast('无可撤销'); return; }
      var snap = TE.hist.pop();
      t.notes.length = 0;
      JSON.parse(snap).forEach(function (n) { t.notes.push(n); });
      TE.sel = -1;
      drawPiano();
      updateTeInfo();
      recalcDuration();
      var row0 = el.trackList.children[TE.idx];
      if (row0) {
        var n0 = row0.querySelector('.trow-n');
        if (n0) n0.textContent = t.notes.length;
      }
      return;
    }

    if (act === 'zoomin' || act === 'zoomout') {
      var z = act === 'zoomin' ? 1.6 : 1 / 1.6;
      TE.zoom = clamp(TE.zoom * z, 1, 16);
      if (TE.zoom <= 1.001) { TE.zoom = 1; TE.pan = 0; }
      el.teScrollWrap.classList.toggle('on', TE.zoom > 1.001);
      el.teScroll.value = TE.pan;
      drawPiano();
      return;
    }

    if (act === 'deltrack') {
      var now = Date.now();
      if (TE.pendingDel && now - TE.pendingDel < 2600) {
        TE.pendingDel = 0;
        S.tracks.splice(TE.idx, 1);
        closeTrackEditor();
        recalcDuration();
        renderTracks();
        toast('已删除轨道');
      } else {
        TE.pendingDel = now;
        toast('再点一次删除轨道');
      }
      return;
    }

    if (act && act.charAt(0) === 'q') {
      TE.grid = parseInt(act.slice(1), 10) || 16;
      teSyncToolUI();
      drawPiano();
      return;
    }

    if (act === 'snap') {
      tePush();
      var gr = noteGrid();
      for (var j = 0; j < t.notes.length; j++) {
        var nn = t.notes[j];
        nn.start = Math.max(0, Math.round(nn.start / gr) * gr);
        var ee = Math.round(nn.end / gr) * gr;
        if (ee <= nn.start) ee = nn.start + gr;
        nn.end = ee;
      }
      teCommit();
      return;
    }

    var targets = (TE.sel >= 0 && t.notes[TE.sel]) ? [t.notes[TE.sel]] : t.notes;
    tePush();

    if (act === 'dn12' || act === 'dn1' || act === 'up1' || act === 'up12') {
      var dv = act === 'dn12' ? -12 : act === 'dn1' ? -1 : act === 'up1' ? 1 : 12;
      for (var i = 0; i < targets.length; i++) {
        targets[i].pitch = clamp(targets[i].pitch + dv, 0, 127);
      }
    } else if (act === 'del') {
      if (TE.sel >= 0) t.notes.splice(TE.sel, 1);
      else t.notes.length = 0;
    }

    teCommit();
  }

  /* ---- 画布交互 ---- */
  var tePointers = {};

  function noteGrid() {
    var div = TE.grid || 16;
    return Math.max(0.02, (S.beatSec || 0.5) * 4 / div);
  }

  function teSyncToolUI() {
    var btns = el.te.querySelectorAll('.tool[data-act^="q"]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].getAttribute('data-act') === 'q' + (TE.grid || 16));
    }
  }

  function teRestoreLast() {
    var t = S.tracks[TE.idx];
    if (!t || !TE.hist.length) return;
    var snap = TE.hist.pop();
    t.notes.length = 0;
    JSON.parse(snap).forEach(function (n) { t.notes.push(n); });
  }

  function teStartPinch() {
    var t = S.tracks[TE.idx];
    if (!t) return;
    if (TE.drag && TE.drag.created) {
      teRestoreLast();
      TE.sel = -1;
    }
    TE.drag = null;
    var ids = Object.keys(tePointers);
    if (ids.length < 2) return;
    var p1 = tePointers[ids[0]], p2 = tePointers[ids[1]];
    TE.pinch = {
      d0: Math.max(1, Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2))),
      cx0: (p1.x + p2.x) / 2,
      zoom0: TE.zoom,
      span0: TE.viewSpan,
      start0: TE.viewStart,
      rect: el.piano.getBoundingClientRect()
    };
    drawPiano();
    updateTeInfo();
  }

  function tePinchMove() {
    var ids = Object.keys(tePointers);
    if (ids.length < 2 || !TE.pinch) return;
    var p1 = tePointers[ids[0]], p2 = tePointers[ids[1]];
    var d = Math.max(1, Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2)));
    var cx = (p1.x + p2.x) / 2;
    var rect = TE.pinch.rect;
    var total = (TE.range && TE.range.t1) || 1;

    var tC = TE.pinch.start0 + ((TE.pinch.cx0 - rect.left) / pW) * TE.pinch.span0;
    var z = clamp(TE.pinch.zoom0 * (d / TE.pinch.d0), 1, 16);
    var span = total / z;
    if (span > total) span = total;
    var st = tC - ((cx - rect.left) / pW) * span;
    st = clamp(st, 0, Math.max(0, total - span));

    TE.zoom = z;
    TE.pan = (total - span) > 0.001 ? st / (total - span) : 0;
    el.teScrollWrap.classList.toggle('on', TE.zoom > 1.001);
    el.teScroll.value = TE.pan;
    drawPiano();
  }

  el.piano.addEventListener('pointerdown', function (e) {
    if (TE.idx < 0) return;
    var t = S.tracks[TE.idx];
    if (!t) return;

    tePointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    try { el.piano.setPointerCapture(e.pointerId); } catch (err) { }

    if (Object.keys(tePointers).length >= 2) {
      teStartPinch();
      return;
    }

    var rect = el.piano.getBoundingClientRect();
    var px = e.clientX - rect.left;
    var py = e.clientY - rect.top;
    var hit = hitTest(px, py);

    if (hit.mode === 'none') {
      TE.sel = -1;
      drawPiano();
      updateTeInfo();
      return;
    }

    if (hit.mode === 'new') {
      tePush();
      var nn = {
        pitch: clamp(hit.pitch, 0, 127),
        start: clampT(hit.time),
        end: clampT(hit.time) + (S.beatSec || 0.5) / 2,
        vel: 100
      };
      t.notes.push(nn);
      TE.sel = t.notes.length - 1;
      TE.drag = {
        mode: 'len', idx: TE.sel, rect: rect, created: true,
        px0: px, py0: py, start0: nn.start, end0: nn.end, pitch0: nn.pitch
      };
      drawPiano();
      updateTeInfo();
      return;
    }

    TE.sel = hit.i;
    var n2 = t.notes[hit.i];
    TE.drag = {
      mode: hit.mode,
      idx: hit.i,
      rect: rect,
      px0: px, py0: py,
      start0: n2.start, end0: n2.end, pitch0: n2.pitch
    };
    drawPiano();
    updateTeInfo();
  });

  el.piano.addEventListener('pointermove', function (e) {
    if (tePointers[e.pointerId]) {
      tePointers[e.pointerId].x = e.clientX;
      tePointers[e.pointerId].y = e.clientY;
    }
    if (TE.pinch) { tePinchMove(); return; }

    if (!TE.drag || TE.idx < 0) return;
    var t = S.tracks[TE.idx];
    if (!t) return;
    var d = TE.drag;
    var n = t.notes[d.idx];
    if (!n) return;

    var R = TE.range || teRange();
    var px = e.clientX - d.rect.left;
    var py = e.clientY - d.rect.top;
    var sx = pW / (TE.viewSpan || R.t1);
    var rowH = pH / (R.hi - R.lo);
    if (!isFinite(sx) || sx <= 0 || !isFinite(rowH) || rowH <= 0) return;

    if (d.mode === 'move') {
      var dt = (px - d.px0) / sx;
      var dp = Math.round((d.py0 - py) / rowH);
      var len = d.end0 - d.start0;
      n.start = clampT(d.start0 + dt);
      n.end = clampT(n.start + len);
      n.pitch = clamp(d.pitch0 + dp, 0, 127);
    } else {
      var dt2 = (px - d.px0) / sx;
      n.end = clampT(Math.max(n.start + 0.03, d.end0 + dt2));
    }
    drawPiano();
    updateTeInfo();
  });

  function endPianoDrag() {
    if (!TE.drag) return;
    var t = S.tracks[TE.idx];
    var n = t ? t.notes[TE.drag.idx] : null;
    if (n) snapNote(n);
    TE.drag = null;
    teCommit();
  }

  el.piano.addEventListener('pointerup', function (e) {
    delete tePointers[e.pointerId];
    if (TE.pinch) {
      if (Object.keys(tePointers).length < 2) TE.pinch = null;
      return;
    }
    endPianoDrag();
  });

  el.piano.addEventListener('pointercancel', function (e) {
    delete tePointers[e.pointerId];
    if (TE.pinch) {
      if (Object.keys(tePointers).length < 2) TE.pinch = null;
      return;
    }
    TE.drag = null;
    drawPiano();
  });

  el.teScroll.addEventListener('input', function () {
    TE.pan = clamp(parseFloat(el.teScroll.value) || 0, 0, 1);
    drawPiano();
  });

  /* ---------------- 时钟 ---------------- */
  var lastCur = -1, lastDur = -1;
  function updateClock() {
    var c = Math.round(S.cursor * 10);
    if (c !== lastCur) {
      lastCur = c;
      el.clockCur.textContent = fmtTime(S.cursor);
      if (el.vizCur) el.vizCur.textContent = S.cursor.toFixed(1);
    }
    var d = Math.round(S.duration * 10);
    if (d !== lastDur) { lastDur = d; el.clockDur.textContent = fmtTime(S.duration); }
  }

  /* ---------------- 主循环 ---------------- */
  function loop() {
    if (S.playing && S.ctx) {
      S.cursor = S.startMusic + (S.ctx.currentTime - S.startCtx);
      if (S.cursor >= S.duration) {
        S.cursor = 0;
        stopPlayback(true);
      } else if (S.ctx.currentTime >= S.nextSched) {
        S.nextSched = S.ctx.currentTime + 0.12;
        schedNotes();
      }
    }
    drawViz();
    updateClock();
    requestAnimationFrame(loop);
  }

  /* ============================================================
     工作台
     ============================================================ */

  var WB = {
    sample: null,
    buf: null,
    orig: null,
    sel: null,
    drag: null,
    hist: [],
    peaks: null,
    peaksW: -1,
    peaksBuf: null
  };

  var waveCtx = null, waveW = 0, waveH = 0;

  function resizeWave() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var rect = el.wave.getBoundingClientRect();
    waveW = Math.max(1, Math.round(rect.width));
    waveH = Math.max(1, Math.round(rect.height));
    el.wave.width = Math.round(waveW * dpr);
    el.wave.height = Math.round(waveH * dpr);
    waveCtx = el.wave.getContext('2d');
    waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    WB.peaks = null;
    WB.peaksW = -1;
  }

  function wavePeaks(W) {
    if (WB.peaks && WB.peaksW === W && WB.peaksBuf === WB.buf) return WB.peaks;
    WB.peaks = AU.peaks(WB.buf, W);
    WB.peaksW = W;
    WB.peaksBuf = WB.buf;
    return WB.peaks;
  }

  function drawWave() {
    if (!waveCtx) return;
    var W = waveW, H = waveH;
    var g = waveCtx;
    g.clearRect(0, 0, W, H);

    g.strokeStyle = 'rgba(255,255,255,.05)';
    for (var gx = 0; gx < W; gx += 26) {
      g.beginPath(); g.moveTo(gx + .5, 0); g.lineTo(gx + .5, H); g.stroke();
    }

    if (!WB.buf) { el.wbSel.textContent = '—'; return; }
    var len = WB.buf.length;

    var x0 = 0, x1 = 0;
    if (WB.sel) {
      x0 = (WB.sel.a / len) * W;
      x1 = (WB.sel.b / len) * W;
      g.fillStyle = 'rgba(255,95,184,.15)';
      g.fillRect(x0, 0, Math.max(1, x1 - x0), H);
      g.strokeStyle = 'rgba(255,95,184,.85)';
      g.beginPath(); g.moveTo(x0 + .5, 0); g.lineTo(x0 + .5, H); g.stroke();
      g.beginPath(); g.moveTo(x1 + .5, 0); g.lineTo(x1 + .5, H); g.stroke();
    }

    var peaks = wavePeaks(W);
    var mid = H / 2;
    var grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#ff5fb8');
    grad.addColorStop(0.5, '#b46bff');
    grad.addColorStop(1, '#43e7ff');
    g.fillStyle = grad;
    for (var i = 0; i < W; i++) {
      var v = peaks[i] || 0;
      var hh = Math.max(0.6, v * (H * 0.45));
      g.fillRect(i, mid - hh, 1, hh * 2);
    }

    g.strokeStyle = 'rgba(255,255,255,.18)';
    g.beginPath(); g.moveTo(0, mid + .5); g.lineTo(W, mid + .5); g.stroke();
  }

  function updateSelLabel() {
    if (!WB.sel || !WB.buf) { el.wbSel.textContent = '—'; return; }
    var sr = WB.buf.sampleRate;
    var d = (WB.sel.b - WB.sel.a) / sr;
    var total = WB.buf.length / sr;
    el.wbSel.textContent = d.toFixed(2) + 's / ' + total.toFixed(2) + 's';
  }

  /* ---- 工作台撤销栈 ---- */
  function wbPush() {
    WB.hist.push({ buf: WB.buf, sel: WB.sel ? { a: WB.sel.a, b: WB.sel.b } : null });
    if (WB.hist.length > 30) WB.hist.shift();
  }

  function wbCommit() {
    WB.peaks = null;
    WB.peaksW = -1;
    drawWave();
    updateSelLabel();
  }

  /* 把工作台草稿同步回采样库 */
  function syncSample() {
    if (!WB.sample) return;
    WB.sample.buffer = WB.buf;
    WB.sample.peaks = AU.peaks(WB.buf, 72);
    renderSamples();
  }

  /* ---- 打开 ---- */
  function openWorkbench(s) {
    WB.sample = s;
    WB.buf = s.buffer;
    WB.orig = s.orig || s.buffer;
    WB.sel = null;
    WB.hist = [];
    WB.peaks = null;
    WB.peaksW = -1;
    el.wbName.textContent = s.name;
    var rt = s.rate || 1;
    if (el.wbRate) el.wbRate.value = rt;
    if (el.wbRateVal) el.wbRateVal.textContent = rt.toFixed(2) + 'x';
    el.wb.classList.add('open');
    requestAnimationFrame(function () {
      resizeWave();
      drawWave();
      updateSelLabel();
    });
  }
  function closeWorkbench() {
    el.wb.classList.remove('open');
    WB.drag = null;
    if (WB.sample && WB.buf !== WB.sample.buffer) syncSample();
  }

  /* ---- 波形交互 ---- */
  el.wave.addEventListener('pointerdown', function (e) {
    if (!WB.buf) return;
    var rect = el.wave.getBoundingClientRect();
    var len = WB.buf.length;
    var x = clamp(e.clientX - rect.left, 0, rect.width);
    var idx = Math.round((x / rect.width) * len);
    WB.drag = { start: idx, rect: rect, len: len };
    WB.sel = { a: idx, b: idx };
    try { el.wave.setPointerCapture(e.pointerId); } catch (err) { }
    drawWave();
    updateSelLabel();
  });

  el.wave.addEventListener('pointermove', function (e) {
    if (!WB.drag) return;
    var rect = WB.drag.rect;
    var x = clamp(e.clientX - rect.left, 0, rect.width);
    var idx = Math.round((x / rect.width) * WB.drag.len);
    WB.sel = {
      a: Math.min(WB.drag.start, idx),
      b: Math.max(WB.drag.start, idx)
    };
    drawWave();
    updateSelLabel();
  });

  el.wave.addEventListener('pointerup', function () {
    if (!WB.drag) return;
    WB.drag = null;
    if (WB.sel && WB.sel.b - WB.sel.a < 48) WB.sel = null;
    drawWave();
    updateSelLabel();
  });
  el.wave.addEventListener('pointercancel', function () { WB.drag = null; });

  /* ---- 波形操作 ---- */
  var OPS = [
    { id: 'trim', label: '裁剪' },
    { id: 'delete', label: '删除' },
    { id: 'silence', label: '静音' },
    { id: 'fadein', label: '淡入' },
    { id: 'fadeout', label: '淡出' },
    { id: 'reverse', label: '反转' },
    { id: 'normalize', label: '归一化' },
    { id: 'all', label: '全选' }
  ];

  function buildOps() {
    OPS.forEach(function (o) {
      var b = document.createElement('button');
      b.className = 'op';
      b.textContent = o.label;
      b.dataset.op = o.id;
      el.wbOps.appendChild(b);
    });
  }

  el.wbOps.addEventListener('click', function (e) {
    var b = e.target.closest('.op');
    if (!b || !WB.buf) return;
    doOp(b.dataset.op);
  });

  function doOp(id) {
    if (!WB.buf) return;
    var len = WB.buf.length;

    if (id === 'all') {
      WB.sel = { a: 0, b: len };
      drawWave();
      updateSelLabel();
      return;
    }
    if (!WB.sel) { toast('SELECT FIRST'); return; }
    var sel = WB.sel;

    wbPush();
    if (id === 'trim') { WB.buf = AU.slice(WB.buf, sel.a, sel.b); WB.sel = null; }
    else if (id === 'delete') { WB.buf = AU.removeRange(WB.buf, sel.a, sel.b); WB.sel = null; }
    else if (id === 'silence') { WB.buf = AU.silence(WB.buf, sel.a, sel.b); WB.sel = null; }
    else if (id === 'fadein') { WB.buf = AU.fade(WB.buf, sel.a, sel.b, 1); }
    else if (id === 'fadeout') { WB.buf = AU.fade(WB.buf, sel.a, sel.b, -1); }
    else if (id === 'reverse') { WB.buf = AU.reverse(WB.buf); }
    else if (id === 'normalize') { WB.buf = AU.normalize(WB.buf, 0.94); }

    wbCommit();
    syncSample();
  }

  /* ---- 效果器 ---- */
  var FX = [
    {
      group: '滤波', items: [
        {
          id: 'highpass', label: '高通', min: 20, max: 8000, step: 10, def: 20,
          fmt: function (v) { return v <= 22 ? '关' : Math.round(v) + 'Hz'; }
        },
        {
          id: 'lowpass', label: '低通', min: 200, max: 20000, step: 10, def: 20000,
          fmt: function (v) { return v >= 19500 ? '关' : Math.round(v) + 'Hz'; }
        }
      ]
    },
    {
      group: '失真', items: [
        {
          id: 'drive', label: '过载', min: 0, max: 1, step: 0.01, def: 0,
          fmt: function (v) { return v <= 0.001 ? '关' : Math.round(v * 100) + '%'; }
        },
        {
          id: 'bitcrush', label: '降位', min: 0, max: 1, step: 0.01, def: 0,
          fmt: function (v) { return v <= 0.001 ? '关' : Math.round(v * 100) + '%'; }
        }
      ]
    },
    {
      group: '空间', items: [
        {
          id: 'delayTime', label: '延迟', min: 0, max: 0.9, step: 0.01, def: 0,
          fmt: function (v) { return v <= 0.001 ? '关' : Math.round(v * 1000) + 'ms'; }
        },
        {
          id: 'delayFb', label: '反馈', min: 0, max: 0.85, step: 0.01, def: 0.32,
          fmt: function (v) { return Math.round(v * 100) + '%'; }
        },
        {
          id: 'reverb', label: '混响', min: 0, max: 1, step: 0.01, def: 0,
          fmt: function (v) { return v <= 0.001 ? '关' : Math.round(v * 100) + '%'; }
        }
      ]
    },
    {
      group: '音高', items: [
        {
          id: 'pitch', label: '变调', min: -12, max: 12, step: 1, def: 0,
          fmt: function (v) { return v === 0 ? '0' : (v > 0 ? '+' : '') + v + 'st'; }
        },
        {
          id: 'speed', label: '速度', min: 0.5, max: 2, step: 0.01, def: 1,
          fmt: function (v) { return v.toFixed(2) + 'x'; }
        },
        {
          id: 'gain', label: '增益', min: 0, max: 2, step: 0.01, def: 1,
          fmt: function (v) {
            var db = v <= 0.001 ? -60 : 20 * Math.log10(v);
            return (db > 0 ? '+' : '') + db.toFixed(1) + 'dB';
          }
        }
      ]
    }
  ];

  var fxParams = {};
  var fxUI = {};

  function buildFx() {
    FX.forEach(function (grp) {
      var box = document.createElement('div');
      box.className = 'fx-group';

      var head = document.createElement('div');
      head.className = 'fx-head';
      head.textContent = grp.group;
      box.appendChild(head);

      grp.items.forEach(function (it) {
        fxParams[it.id] = it.def;

        var row = document.createElement('label');
        row.className = 'fx-row';

        var lab = document.createElement('span');
        lab.textContent = it.label;
        row.appendChild(lab);

        var inp = document.createElement('input');
        inp.type = 'range';
        inp.min = it.min;
        inp.max = it.max;
        inp.step = it.step;
        inp.value = it.def;
        row.appendChild(inp);

        var out = document.createElement('output');
        out.textContent = it.fmt(it.def);
        row.appendChild(out);

        inp.addEventListener('input', function () {
          var v = parseFloat(inp.value);
          fxParams[it.id] = v;
          out.textContent = it.fmt(v);
          row.classList.toggle('dirty', Math.abs(v - it.def) > 1e-6);
        });

        fxUI[it.id] = { inp: inp, out: out, row: row, def: it };
        box.appendChild(row);
      });

      el.wbFx.appendChild(box);
    });
  }

  function resetFx() {
    for (var id in fxUI) {
      var u = fxUI[id];
      fxParams[id] = u.def.def;
      u.inp.value = u.def.def;
      u.out.textContent = u.def.fmt(u.def.def);
      u.row.classList.remove('dirty');
    }
  }

  function currentFx() {
    var p = {};
    for (var k in fxParams) p[k] = fxParams[k];
    if (p.speed <= 0) p.speed = 1;
    if (p.gain < 0) p.gain = 0;
    return p;
  }

  function fxIsDefault() {
    for (var k in fxParams) {
      for (var id in fxUI) {
        if (id === k && Math.abs(fxParams[k] - fxUI[id].def.def) > 1e-6) return false;
      }
    }
    return true;
  }

  /* ---- 应用 / 试听 / 还原 ---- */
  async function wbApply() {
    if (!WB.buf || !WB.sample) return;
    var p = currentFx();
    var out;
    if (fxIsDefault()) {
      out = WB.buf;
    } else {
      toast('RENDER');
      try {
        out = await AU.renderFx(WB.buf, p);
      } catch (e) {
        console.error(e);
        toast('RENDER FAIL');
        return;
      }
    }
    wbPush();
    WB.buf = out;
    WB.sel = null;
    resetFx();
    wbCommit();
    syncSample();
    toast('APPLIED · ' + out.duration.toFixed(2) + 's');
  }

  async function wbPreview() {
    if (!WB.buf) return;
    var p = currentFx();
    var out;
    if (fxIsDefault()) {
      out = WB.buf;
    } else {
      toast('RENDER');
      try {
        out = await AU.renderFx(WB.buf, p);
      } catch (e) {
        toast('RENDER FAIL');
        return;
      }
    }
    stopNodes();
    previewBuffer(out);
  }

  el.wbRate.addEventListener('input', function () {
    if (!WB.sample) return;
    var v = parseFloat(el.wbRate.value) || 1;
    WB.sample.rate = v;
    el.wbRateVal.textContent = v.toFixed(2) + 'x';
  });

  el.wbApply.addEventListener('click', wbApply);
  el.wbPreview.addEventListener('click', wbPreview);
  el.wbClose.addEventListener('click', closeWorkbench);

  el.wbRevert.addEventListener('click', function () {
    if (!WB.sample) return;
    wbPush();
    WB.buf = WB.orig;
    WB.sel = null;
    resetFx();
    wbCommit();
    syncSample();
    toast('REVERTED');
  });

  var wbDelPending = 0;
  el.wbDelete.addEventListener('click', function () {
    if (!WB.sample) return;
    var now = Date.now();
    if (!wbDelPending || now - wbDelPending > 2600) {
      wbDelPending = now;
      toast('再点一次删除采样');
      return;
    }
    wbDelPending = 0;
    var gone = WB.sample;
    WB.sample = null;
    closeWorkbench();
    var idx = S.samples.indexOf(gone);
    if (idx >= 0) S.samples.splice(idx, 1);
    for (var i = 0; i < S.tracks.length; i++) {
      if (S.tracks[i].sampleId === gone.id) {
        S.tracks[i].sampleId = null;
        S.tracks[i]._gmKey = null;
      }
    }
    renderSamples();
    renderTracks();
    toast('已删除采样');
  });

  el.wbUndo.addEventListener('click', function () {
    if (!WB.hist.length) { toast('NOTHING'); return; }
    var h = WB.hist.pop();
    WB.buf = h.buf;
    WB.sel = h.sel;
    wbCommit();
    syncSample();
  });

  /* ============================================================
     全局事件
     ============================================================ */

  el.play.addEventListener('click', togglePlay);
  el.stop.addEventListener('click', function () {
    stopPlayback(false);
  });
  el.exp.addEventListener('click', exportWav);

  el.masterVol.addEventListener('input', function () {
    if (S.master) S.master.gain.value = parseFloat(el.masterVol.value);
  });

  document.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (t) {
        t.classList.toggle('active', t === tab);
      });
      var which = tab.dataset.tab;
      el.trackList.classList.toggle('hide', which !== 'tracks');
      el.sampleList.classList.toggle('hide', which !== 'samples');
      if (which === 'samples') renderSamples();
    });
  });

  el.fileMidi.addEventListener('change', function (e) {
    if (e.target.files && e.target.files.length) routeFiles(e.target.files);
    e.target.value = '';
  });
  el.fileMp3.addEventListener('change', function (e) {
    if (e.target.files && e.target.files.length) routeFiles(e.target.files);
    e.target.value = '';
  });

  /* 宿主 WebView 未实现文件选择器时，退回到内置目录列表 */
  var pickerWarned = false;

  function closePicker() {
    el.picker.classList.remove('open');
  }

  function openPicker() {
    el.picker.classList.add('open');
    var host = el.pkList;
    host.innerHTML = '<div class="empty">读取中…</div>';

    var EXT_RE = /\.(mid|midi|mp3|wav|ogg|m4a|flac|aac|opus|mp4|m4v|mov|webm|mkv|avi)$/i;

    function render(items) {
      host.innerHTML = '';
      if (!items || !items.length) {
        host.innerHTML = '<div class="empty">媒体库为空 · 用 +音频 上传</div>';
        return;
      }
      items.forEach(function (it) {
        var label = (typeof it === 'string') ? it : it.n;
        var url = (typeof it === 'string') ? ('./' + encodeURIComponent(it)) : it.u;
        var b = document.createElement('button');
        b.className = 'pk-item';
        b.textContent = label;
        b.addEventListener('click', function () { loadFromUrl(url); });
        host.appendChild(b);
      });
    }

    function parseDir(html, base, tag) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var as = doc.querySelectorAll('a');
      var out = [];
      for (var i = 0; i < as.length; i++) {
        var h = as[i].getAttribute('href');
        if (!h || !EXT_RE.test(h)) continue;
        var n = h.split('/').pop();
        try { n = decodeURIComponent(n); } catch (e) { }
        if (!n) continue;
        out.push({ n: (tag ? tag + ' · ' : '') + n, u: base + encodeURIComponent(n) });
      }
      return out;
    }

    fetch('./__list', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('no list'); return r.json(); })
      .then(function (arr) { render(arr); })
      .catch(function () {
        fetch('./media/', { cache: 'no-store' })
          .then(function (r) { if (!r.ok) throw new Error('no media'); return r.text(); })
          .then(function (html) {
            var items = parseDir(html, './media/', 'media');
            if (!items.length) throw new Error('empty');
            render(items);
          })
          .catch(function () {
            fetch('./', { cache: 'no-store' })
              .then(function (r) { return r.text(); })
              .then(function (html) {
                var items = parseDir(html, './', '');
                if (items.length) { render(items); return; }
                host.innerHTML = '<div class="empty">当前页面未连本地服务器</div>';
              })
              .catch(function () { host.innerHTML = '<div class="empty">当前页面未连本地服务器</div>'; });
          });
      });
  }

  function loadFromUrl(url) {
    var full = 'file';
    try {
      var u = new URL(url, location.href);
      var qf = u.searchParams.get('f');
      full = qf ? decodeURIComponent(qf) : decodeURIComponent(u.pathname.split('/').pop() || 'file');
    } catch (e) {
      full = url.split('?')[0].split('/').pop() || 'file';
    }
    var isMidi = /\.(mid|midi)$/i.test(full);
    var isVideo = /\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(full);
    var name = full.replace(/\.[^.]+$/, '');
    fetch(url)
      .then(function (r) { return r.blob(); })
      .then(async function (blob) {
        if (isMidi) {
          var ab = await blob.arrayBuffer();
          applyMidi(MIDI.parse(ab), name + '.mid');
        } else {
          var buf = null;
          try {
            buf = await decodeAudio(ac(), await blob.arrayBuffer());
          } catch (e1) {
            console.warn('[decode]', e1);
            buf = await grabFromElement(blob, isVideo);
            toast('已抓取前 5 秒');
          }
          addSample(name, buf, isVideo);
        }
        closePicker();
      })
      .catch(function (e) {
        console.error(e);
        toast('载入失败');
      });
  }

  el.pkClose.addEventListener('click', closePicker);

  function watchPicker(input) {
    input.addEventListener('click', function () {
      if (pickerWarned) { openPicker(); return; }
      setTimeout(function () {
        if (document.hasFocus() && !input.files.length) {
          pickerWarned = true;
          toast('此环境不支持选择文件');
          openPicker();
        }
      }, 1000);
    });
  }
  watchPicker(el.fileMidi);
  watchPicker(el.fileMp3);

  /* 拖放 */
  ['dragenter', 'dragover'].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
  });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    var files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    routeFiles(files);
  });

  /* 快捷键 */
  document.addEventListener('keydown', function (e) {
    if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.code === 'Escape') {
      if (el.wb.classList.contains('open')) closeWorkbench();
      else if (el.te.classList.contains('open')) closeTrackEditor();
    }
  });

  /* 窗口尺寸 */
  var rzT = 0;
  window.addEventListener('resize', function () {
    clearTimeout(rzT);
    rzT = setTimeout(function () {
      fitViz();
      if (el.te.classList.contains('open')) {
        fitPiano();
        drawPiano();
      }
      if (el.wb.classList.contains('open')) {
        resizeWave();
        drawWave();
      }
    }, 90);
  });

  /* ---------------- 启动 ---------------- */
  buildOps();
  buildFx();
  fitViz();
  loadGM();
  renderTracks();
  renderSamples();
  updateClock();
  requestAnimationFrame(loop);

  /* ---------------- URL 预载：?midi=a.mid&mp3=b.wav,c.mp3 ---------------- */
  (function preloadFromQuery() {
    var q;
    try { q = new URLSearchParams(location.search); } catch (e) { return; }
    var midiUrl = q.get('midi');
    var audioUrls = [];
    ['mp3', 'audio', 'sample'].forEach(function (k) {
      var v = q.get(k);
      if (v) audioUrls = audioUrls.concat(v.split(',').map(function (s) { return s.trim(); }).filter(Boolean));
    });
    if (!midiUrl && !audioUrls.length) return;

    function baseName(u) {
      var n = u.split('?')[0].split('/').pop() || 'sample';
      try { n = decodeURIComponent(n); } catch (e) { }
      return n.replace(/\.[^.]+$/, '');
    }
    function getBlob(url) {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error(r.status + ' ' + url);
        return r.blob();
      });
    }

    (async function () {
      for (var i = 0; i < audioUrls.length; i++) {
        try {
          var ab = await (await getBlob(audioUrls[i])).arrayBuffer();
          var buf = await decodeAudio(ac(), ab);
          addSample(baseName(audioUrls[i]), buf);
        } catch (e) { console.error('[preload audio]', e); }
      }
      if (midiUrl) {
        try {
          var mb = await (await getBlob(midiUrl)).arrayBuffer();
          applyMidi(MIDI.parse(mb), baseName(midiUrl) + '.mid');
        } catch (e) {
          console.error('[preload midi]', e);
          toast('MIDI LOAD FAIL');
        }
      }
    })();
  })();

  /* 非本地服务环境（file:// 或其他端口）下无法上传，直接给出出路 */
  (function envBar() {
    var bad = (location.protocol === 'file:') ||
      (location.port && location.port !== '8123');
    if (!bad) return;
    var bar = document.createElement('div');
    bar.className = 'envbar';
    bar.innerHTML = '当前环境不支持上传 · <b>点此切到本地服务器</b>';
    bar.addEventListener('click', function () {
      location.href = 'http://127.0.0.1:8123/index.html' + location.search;
    });
    document.body.appendChild(bar);
  })();

  /* 首次交互解锁音频 */
  var unlocked = false;
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    ac();
    document.removeEventListener('pointerdown', unlock);
    document.removeEventListener('keydown', unlock);
  }
  document.addEventListener('pointerdown', unlock);
  document.addEventListener('keydown', unlock);

})();