(() => {
  'use strict';

  const defaults = { x: 0.68, y: 0.31, intensity: 80, spread: 65, lightHeight: 55, temperature: 5500, relief: 35, normalStrength: 100, shadow: 40, depthStrength: 45, castStrength: 0, castSoftness: 70 };
  const state = { ...defaults, compare: false, before: false, depthPreview: false, normalPreview: false, split: 0.5, image: null, imageName: 'サンプルイラスト', depthEditing: false, depthBusy: false, hasEstimatedDepth: false, brushMode: 'near', brushSize: 10 };
  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const artboard = $('artboard');
  const stage = $('dropZone');
  const fileInput = $('fileInput');
  const sliderIds = ['intensity', 'spread', 'lightHeight', 'temperature', 'relief', 'normalStrength', 'shadow', 'depthStrength', 'castStrength', 'castSoftness', 'brushSize'];
  const castPresets = { natural: { castStrength: 0, castSoftness: 70 }, soft: { castStrength: 38, castSoftness: 78 }, dramatic: { castStrength: 90, castSoftness: 20 } };
  const depthCanvas = document.createElement('canvas');
  const depthContext = depthCanvas.getContext('2d');
  const estimatedDepthCanvas = document.createElement('canvas');
  const estimatedDepthContext = estimatedDepthCanvas.getContext('2d');
  const normalCanvas = document.createElement('canvas');
  const normalContext = normalCanvas.getContext('2d');
  const normalDepthCanvas = document.createElement('canvas');
  const normalDepthContext = normalDepthCanvas.getContext('2d');
  let normalUpdateQueued = false;
  let estimatorPromise = null;
  let inferenceQueue = Promise.resolve();
  let depthGeneration = 0;
  let toastTimer;

  const vertexSource = `
    attribute vec2 aPosition;
    varying vec2 vUv;
    void main() {
      vUv = aPosition * 0.5 + 0.5;
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;
  const fragmentSource = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uImage;
    uniform sampler2D uDepthMap;
    uniform sampler2D uNormalMap;
    uniform vec2 uTexel;
    uniform vec2 uLight;
    uniform float uIntensity;
    uniform float uSpread;
    uniform float uTemperature;
    uniform float uRelief;
    uniform float uNormalStrength;
    uniform float uShadow;
    uniform float uDepthStrength;
    uniform float uCastStrength;
    uniform float uCastSoftness;
    uniform float uLightHeight;
    uniform float uShowDepth;
    uniform float uShowNormal;
    uniform float uAspect;
    uniform float uCompare;
    uniform float uBefore;
    uniform float uSplit;

    float heightAt(vec2 uv) {
      vec4 p = texture2D(uImage, clamp(uv, vec2(0.0), vec2(1.0)));
      return dot(p.rgb, vec3(0.299, 0.587, 0.114)) * 0.76 + p.a * 0.24;
    }
    float castShadowAt(vec2 uv, float receiverDepth) {
      float projection = 1.0 + mix(0.82, 0.12, uLightHeight) * mix(0.55, 1.0, uCastStrength);
      vec2 sampleUv = uLight + (uv - uLight) / projection;
      if (sampleUv.x <= 0.0 || sampleUv.x >= 1.0 || sampleUv.y <= 0.0 || sampleUv.y >= 1.0) return 0.0;
      float blocker = texture2D(uDepthMap, sampleUv).r;
      if (uCastSoftness > 0.01) {
        vec2 blur = vec2(uCastSoftness * 0.018 / uAspect, uCastSoftness * 0.018);
        blocker = blocker * 0.4
                + texture2D(uDepthMap, sampleUv + vec2(blur.x, 0.0)).r * 0.15
                + texture2D(uDepthMap, sampleUv - vec2(blur.x, 0.0)).r * 0.15
                + texture2D(uDepthMap, sampleUv + vec2(0.0, blur.y)).r * 0.15
                + texture2D(uDepthMap, sampleUv - vec2(0.0, blur.y)).r * 0.15;
      }
      return smoothstep(0.17, 0.37 + uCastSoftness * 0.06, blocker - receiverDepth);
    }
    void main() {
      vec4 source = texture2D(uImage, vUv);
      float depth = texture2D(uDepthMap, vUv).r;
      if (uShowDepth > 0.5) {
        gl_FragColor = vec4(vec3(depth), source.a);
        return;
      }
      if (uShowNormal > 0.5) {
        gl_FragColor = vec4(texture2D(uNormalMap, vUv).rgb, source.a);
        return;
      }
      if (uBefore > 0.5 || (uCompare > 0.5 && vUv.x < uSplit)) {
        gl_FragColor = source;
        return;
      }
      if (source.a < 0.001) {
        gl_FragColor = source;
        return;
      }

      vec2 fine = uTexel * 2.0;
      vec2 broad = uTexel * 11.0;
      float dx = (heightAt(vUv - vec2(fine.x, 0.0)) - heightAt(vUv + vec2(fine.x, 0.0))) * 0.58
               + (heightAt(vUv - vec2(broad.x, 0.0)) - heightAt(vUv + vec2(broad.x, 0.0))) * 0.42;
      float dy = (heightAt(vUv - vec2(0.0, fine.y)) - heightAt(vUv + vec2(0.0, fine.y))) * 0.58
               + (heightAt(vUv - vec2(0.0, broad.y)) - heightAt(vUv + vec2(0.0, broad.y))) * 0.42;
      vec3 mappedNormal = texture2D(uNormalMap, vUv).rgb * 2.0 - 1.0;
      vec2 mappedSlope = mappedNormal.xy / max(mappedNormal.z, 0.1);
      vec3 normal = normalize(vec3(dx * uRelief * 7.5 + mappedSlope.x * uNormalStrength,
                                   dy * uRelief * 7.5 + mappedSlope.y * uNormalStrength, 1.0));
      vec2 delta = vec2((uLight.x - vUv.x) * uAspect, uLight.y - vUv.y);
      float dist = length(delta);
      vec3 lightDirection = normalize(vec3(delta * 1.3, mix(0.25, 0.82, uLightHeight)));
      float diffuse = max(dot(normal, lightDirection), 0.0);
      float falloff = exp(-dist * dist / max(0.035, uSpread * uSpread * 0.52));
      float reliefShade = (diffuse - 0.72) * uRelief * 0.78;
      float depthBias = (depth - 0.5) * uDepthStrength;
      float ambient = 1.0 - uShadow * 0.27 + reliefShade * (0.3 + uShadow * 0.7) + depthBias * 0.38;
      float illumination = uIntensity * falloff * (0.30 + diffuse * 0.28) * (1.0 + depthBias * 0.9);

      float warmth = clamp((5500.0 - uTemperature) / 3000.0, 0.0, 1.0);
      float coolness = clamp((uTemperature - 5500.0) / 3500.0, 0.0, 1.0);
      vec3 tint = vec3(1.0) + warmth * vec3(0.11, 0.005, -0.19) + coolness * vec3(-0.13, -0.025, 0.17);
      vec3 lightTint = vec3(1.0) + warmth * vec3(0.12, -0.035, -0.22) + coolness * vec3(-0.20, -0.035, 0.19);
      vec3 color = source.rgb * max(0.0, ambient) * tint;
      color += source.rgb * illumination * lightTint;
      color = mix(color, vec3(dot(color, vec3(0.299, 0.587, 0.114))), (1.0 - depth) * uDepthStrength * 0.08);
      color += vec3(1.0) * pow(max(diffuse, 0.0), 7.0) * falloff * uRelief * uIntensity * 0.07 * lightTint;
      if (uCastStrength > 0.001) {
        float castAmount = castShadowAt(vUv, depth);
        color *= 1.0 - castAmount * uCastStrength * (0.64 + uShadow * 0.25);
      }
      gl_FragColor = vec4(clamp(color, 0.0, 1.0), source.a);
    }
  `;

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  let gl, program, texture, depthTexture, normalTexture, uniforms;
  try {
    gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGLを利用できません');
    program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    depthTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, depthTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    normalTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, normalTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 255, 255]));
    gl.activeTexture(gl.TEXTURE0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    uniforms = Object.fromEntries(['uImage', 'uDepthMap', 'uNormalMap', 'uTexel', 'uLight', 'uIntensity', 'uSpread', 'uTemperature', 'uRelief', 'uNormalStrength', 'uShadow', 'uDepthStrength', 'uCastStrength', 'uCastSoftness', 'uLightHeight', 'uShowDepth', 'uShowNormal', 'uAspect', 'uCompare', 'uBefore', 'uSplit'].map(name => [name, gl.getUniformLocation(program, name)]));
    gl.uniform1i(uniforms.uImage, 0);
    gl.uniform1i(uniforms.uDepthMap, 1);
    gl.uniform1i(uniforms.uNormalMap, 2);
  } catch (error) {
    console.error(error);
    showToast('このブラウザでは画像処理を開始できません');
    return;
  }

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 3000);
  }

  function uploadDepthMap() {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, depthTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, depthCanvas);
    gl.activeTexture(gl.TEXTURE0);
  }

  function updateNormalMap() {
    if (!state.image || !depthCanvas.width || !depthCanvas.height) return;
    const scale = Math.min(1, 512 / Math.max(depthCanvas.width, depthCanvas.height));
    const width = Math.max(1, Math.round(depthCanvas.width * scale));
    const height = Math.max(1, Math.round(depthCanvas.height * scale));
    normalDepthCanvas.width = normalCanvas.width = width;
    normalDepthCanvas.height = normalCanvas.height = height;
    normalDepthContext.drawImage(depthCanvas, 0, 0, width, height);
    const depthPixels = normalDepthContext.getImageData(0, 0, width, height).data;
    const result = normalContext.createImageData(width, height);
    const pixels = result.data;
    const depthAt = (x, y) => depthPixels[(Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))) * 4] / 255;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const left = (depthAt(x - 4, y - 2) + depthAt(x - 4, y) + depthAt(x - 4, y + 2)) / 3;
        const right = (depthAt(x + 4, y - 2) + depthAt(x + 4, y) + depthAt(x + 4, y + 2)) / 3;
        const below = (depthAt(x - 2, y + 4) + depthAt(x, y + 4) + depthAt(x + 2, y + 4)) / 3;
        const above = (depthAt(x - 2, y - 4) + depthAt(x, y - 4) + depthAt(x + 2, y - 4)) / 3;
        const nx = (left - right) * 2.5;
        const ny = (below - above) * 2.5;
        const length = Math.hypot(nx, ny, 1);
        const index = (y * width + x) * 4;
        pixels[index] = Math.round((nx / length * 0.5 + 0.5) * 255);
        pixels[index + 1] = Math.round((ny / length * 0.5 + 0.5) * 255);
        pixels[index + 2] = Math.round((1 / length * 0.5 + 0.5) * 255);
        pixels[index + 3] = 255;
      }
    }
    normalContext.putImageData(result, 0, 0);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, normalTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, normalCanvas);
    gl.activeTexture(gl.TEXTURE0);
    render();
  }

  function scheduleNormalMapUpdate() {
    if (normalUpdateQueued) return;
    normalUpdateQueued = true;
    requestAnimationFrame(() => {
      normalUpdateQueued = false;
      updateNormalMap();
    });
  }

  function resetDepthMap() {
    if (!state.image) return;
    depthCanvas.width = estimatedDepthCanvas.width;
    depthCanvas.height = estimatedDepthCanvas.height;
    depthContext.drawImage(estimatedDepthCanvas, 0, 0);
    uploadDepthMap();
    scheduleNormalMapUpdate();
    render();
  }

  function initializeDepthMap() {
    const scale = Math.min(1, 1024 / Math.max(canvas.width, canvas.height));
    estimatedDepthCanvas.width = Math.max(1, Math.round(canvas.width * scale));
    estimatedDepthCanvas.height = Math.max(1, Math.round(canvas.height * scale));
    estimatedDepthContext.fillStyle = '#808080';
    estimatedDepthContext.fillRect(0, 0, estimatedDepthCanvas.width, estimatedDepthCanvas.height);
    resetDepthMap();
  }

  function setDepthStatus(message, kind = '') {
    const status = $('depthStatus');
    status.textContent = message;
    status.className = `depth-status ${kind}`;
  }

  async function getDepthEstimator() {
    if (!estimatorPromise) {
      estimatorPromise = import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1')
        .then(async ({ pipeline, env }) => {
          env.allowLocalModels = false;
          env.useBrowserCache = true;
          return pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small', {
            dtype: 'q8',
            progress_callback: progress => {
              if (state.depthBusy && progress.status === 'progress' && Number.isFinite(progress.progress)) {
                setDepthStatus(`モデルを取得中 ${Math.round(progress.progress)}%`, 'loading');
              }
            },
          });
        })
        .catch(error => { estimatorPromise = null; throw error; });
    }
    return estimatorPromise;
  }

  function applyEstimatedDepth(rawDepth) {
    if (!rawDepth || !rawDepth.data || !rawDepth.width || !rawDepth.height) throw new Error('深度データがありません');
    if (rawDepth.data.length < rawDepth.width * rawDepth.height * (rawDepth.channels || 1)) throw new Error('深度データが不完全です');
    const source = document.createElement('canvas');
    source.width = rawDepth.width;
    source.height = rawDepth.height;
    const sourceContext = source.getContext('2d');
    const pixels = sourceContext.createImageData(source.width, source.height);
    const channels = rawDepth.channels || 1;
    for (let index = 0; index < source.width * source.height; index++) {
      const value = rawDepth.data[index * channels];
      const offset = index * 4;
      pixels.data[offset] = value;
      pixels.data[offset + 1] = value;
      pixels.data[offset + 2] = value;
      pixels.data[offset + 3] = 255;
    }
    sourceContext.putImageData(pixels, 0, 0);
    estimatedDepthContext.clearRect(0, 0, estimatedDepthCanvas.width, estimatedDepthCanvas.height);
    estimatedDepthContext.drawImage(source, 0, 0, estimatedDepthCanvas.width, estimatedDepthCanvas.height);
    resetDepthMap();
  }

  function estimateDepth() {
    if (!state.image) return;
    const generation = ++depthGeneration;
    const image = state.image;
    state.depthBusy = true;
    state.depthEditing = false;
    state.depthPreview = false;
    setDepthStatus('深度を推定中…', 'loading');
    updateControlUI();
    render();
    inferenceQueue = inferenceQueue.catch(() => {}).then(async () => {
      try {
        const estimator = await getDepthEstimator();
        if (generation !== depthGeneration) return;
        setDepthStatus('画像を解析中…', 'loading');
        const input = document.createElement('canvas');
        const scale = Math.min(1, 768 / Math.max(canvas.width, canvas.height));
        input.width = Math.max(1, Math.round(canvas.width * scale));
        input.height = Math.max(1, Math.round(canvas.height * scale));
        const context = input.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, input.width, input.height);
        context.drawImage(image, 0, 0, input.width, input.height);
        const result = await estimator(input);
        if (generation !== depthGeneration) return;
        applyEstimatedDepth(result.depth);
        state.hasEstimatedDepth = true;
        state.depthBusy = false;
        setDepthStatus('画像から深度を推定しました', 'ready');
        updateControlUI();
        render();
      } catch (error) {
        console.error(error);
        if (generation !== depthGeneration) return;
        state.depthBusy = false;
        setDepthStatus('推定できませんでした。再推定してください', 'error');
        updateControlUI();
        showToast('深度推定に失敗しました。接続を確認してください');
      }
    });
    return inferenceQueue;
  }

  function updateControlUI() {
    for (const id of sliderIds) {
      const slider = $(id);
      slider.value = state[id];
      const percentage = ((Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min))) * 100;
      slider.style.setProperty('--fill', `${percentage}%`);
      $(id + 'Value').textContent = id === 'temperature' ? `${state[id].toLocaleString('ja-JP')} K` : `${state[id]}%`;
    }
    document.querySelectorAll('[data-temperature]').forEach(button => button.classList.toggle('active', Number(button.dataset.temperature) === state.temperature));
    document.querySelectorAll('[data-cast-preset]').forEach(button => {
      const preset = castPresets[button.dataset.castPreset];
      button.classList.toggle('active', state.castStrength === preset.castStrength && state.castSoftness === preset.castSoftness);
    });
    $('miniMapDot').style.left = `${state.x * 100}%`;
    $('miniMapDot').style.top = `${state.y * 100}%`;
    $('miniMap').setAttribute('aria-valuenow', String(Math.round(state.x * 100)));
    $('miniMap').setAttribute('aria-valuetext', `横 ${Math.round(state.x * 100)}%、縦 ${Math.round(state.y * 100)}%`);
    $('lightHandle').style.left = `${state.x * 100}%`;
    $('lightHandle').style.top = `${state.y * 100}%`;
    $('lightHandle').style.opacity = state.compare || state.before || state.depthEditing || state.depthPreview || state.normalPreview ? '0' : '1';
    $('splitLine').hidden = !state.compare;
    $('splitLine').style.left = `${state.split * 100}%`;
    $('beforeCaption').hidden = !state.compare;
    $('afterCaption').hidden = !state.compare;
    $('compareButton').classList.toggle('active', state.compare);
    $('compareButton').setAttribute('aria-pressed', String(state.compare));
    $('beforeButton').classList.toggle('active', state.before);
    $('beforeButton').setAttribute('aria-pressed', String(state.before));
    $('compareButton').disabled = state.depthEditing || state.depthPreview || state.normalPreview;
    $('beforeButton').disabled = state.depthEditing || state.depthPreview || state.normalPreview;
    $('depthViewButton').classList.toggle('active', state.depthPreview);
    $('depthViewButton').setAttribute('aria-pressed', String(state.depthPreview));
    $('depthViewButton').disabled = state.depthBusy || !state.hasEstimatedDepth;
    $('normalViewButton').classList.toggle('active', state.normalPreview);
    $('normalViewButton').setAttribute('aria-pressed', String(state.normalPreview));
    $('normalViewButton').disabled = !state.image;
    $('depthEditButton').classList.toggle('active', state.depthEditing);
    $('depthEditButton').setAttribute('aria-pressed', String(state.depthEditing));
    $('depthEditButton').disabled = state.depthBusy || !state.image;
    $('depthReestimateButton').disabled = state.depthBusy || !state.image;
    $('depthEditButton').querySelector('span').textContent = state.depthEditing ? '編集を終了' : '深度マップを描く';
    $('depthTools').hidden = !state.depthEditing;
    $('nearButton').classList.toggle('active', state.brushMode === 'near');
    $('farButton').classList.toggle('active', state.brushMode === 'far');
    $('nearButton').setAttribute('aria-pressed', String(state.brushMode === 'near'));
    $('farButton').setAttribute('aria-pressed', String(state.brushMode === 'far'));
    artboard.classList.toggle('depth-editing', state.depthEditing);
    artboard.classList.toggle('depth-far', state.depthEditing && state.brushMode === 'far');
    artboard.classList.toggle('depth-preview', state.depthPreview);
    artboard.classList.toggle('normal-preview', state.normalPreview);
    if (!state.depthEditing) $('depthBrushCursor').hidden = true;
    const brushDiameter = Math.min(artboard.clientWidth, artboard.clientHeight) * state.brushSize / 100;
    $('depthBrushCursor').style.width = `${brushDiameter}px`;
    $('depthBrushCursor').style.height = `${brushDiameter}px`;
    $('stageTip').textContent = state.depthEditing ? '白＝手前、黒＝奥。イラスト上をなぞって深度を指定' : state.depthPreview ? '深度マップを表示中：白＝手前、黒＝奥' : state.normalPreview ? '法線マップを表示中：色が面の向きを表します' : state.compare ? '境界線をドラッグして調整前後を比較' : 'イラスト上をクリック・ドラッグして光源を移動';
  }

  function render() {
    if (!state.image) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uniforms.uTexel, 1 / canvas.width, 1 / canvas.height);
    gl.uniform2f(uniforms.uLight, state.x, 1 - state.y);
    gl.uniform1f(uniforms.uIntensity, state.intensity / 100);
    gl.uniform1f(uniforms.uSpread, state.spread / 100);
    gl.uniform1f(uniforms.uTemperature, state.temperature);
    gl.uniform1f(uniforms.uRelief, state.relief / 100);
    gl.uniform1f(uniforms.uNormalStrength, state.normalStrength / 100);
    gl.uniform1f(uniforms.uShadow, state.shadow / 100);
    gl.uniform1f(uniforms.uDepthStrength, state.depthStrength / 100);
    gl.uniform1f(uniforms.uCastStrength, state.castStrength / 100);
    gl.uniform1f(uniforms.uCastSoftness, state.castSoftness / 100);
    gl.uniform1f(uniforms.uLightHeight, state.lightHeight / 100);
    gl.uniform1f(uniforms.uShowDepth, Number(state.depthEditing || state.depthPreview));
    gl.uniform1f(uniforms.uShowNormal, Number(state.normalPreview));
    gl.uniform1f(uniforms.uAspect, canvas.width / canvas.height);
    gl.uniform1f(uniforms.uCompare, Number(state.compare));
    gl.uniform1f(uniforms.uBefore, Number(state.before));
    gl.uniform1f(uniforms.uSplit, state.split);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function fitArtboard() {
    if (!state.image) return;
    const center = document.querySelector('.stage-center');
    const bounds = center.getBoundingClientRect();
    const style = getComputedStyle(center);
    const width = Math.max(100, bounds.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    const height = Math.max(100, bounds.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
    const scale = Math.min(width / canvas.width, height / canvas.height);
    artboard.style.width = `${Math.round(canvas.width * scale)}px`;
    artboard.style.height = `${Math.round(canvas.height * scale)}px`;
    $('zoomLabel').textContent = `${Math.round(scale * 100)}%`;
    const brushDiameter = Math.min(artboard.clientWidth, artboard.clientHeight) * state.brushSize / 100;
    $('depthBrushCursor').style.width = `${brushDiameter}px`;
    $('depthBrushCursor').style.height = `${brushDiameter}px`;
  }

  function setImage(image, name) {
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    let source = image;
    let width = image.naturalWidth || image.width;
    let height = image.naturalHeight || image.height;
    if (Math.max(width, height) > maxSize) {
      const scale = maxSize / Math.max(width, height);
      const temporary = document.createElement('canvas');
      temporary.width = Math.round(width * scale);
      temporary.height = Math.round(height * scale);
      temporary.getContext('2d').drawImage(image, 0, 0, temporary.width, temporary.height);
      source = temporary;
      width = temporary.width;
      height = temporary.height;
      showToast(`画像を ${width} × ${height} px に縮小して読み込みました`);
    }
    canvas.width = width;
    canvas.height = height;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    state.image = source;
    state.imageName = name;
    state.depthEditing = false;
    state.depthPreview = false;
    state.normalPreview = false;
    state.hasEstimatedDepth = false;
    state.compare = false;
    state.before = false;
    $('projectName').textContent = name;
    $('canvasTitle').textContent = name;
    $('imageSize').textContent = `${width} × ${height} px`;
    initializeDepthMap();
    updateControlUI();
    fitArtboard();
    render();
    estimateDepth();
  }

  function loadFile(file) {
    if (!file || !(file.type.startsWith('image/') || /\.(png|jpe?g|webp|svg)$/i.test(file.name))) {
      showToast('PNG・JPEG・WebP・SVG画像を選んでください');
      return;
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try { setImage(image, file.name.replace(/\.[^.]+$/, '')); showToast('画像を読み込みました'); }
      catch (error) { console.error(error); showToast('画像を読み込めませんでした'); }
      URL.revokeObjectURL(url);
    };
    image.onerror = () => { URL.revokeObjectURL(url); showToast('画像を読み込めませんでした'); };
    image.src = url;
  }

  function setLightFromEvent(event, target) {
    const bounds = target.getBoundingClientRect();
    state.x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    state.y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
    updateControlUI();
    render();
  }

  function setSplitFromEvent(event) {
    const bounds = artboard.getBoundingClientRect();
    state.split = Math.max(0.02, Math.min(0.98, (event.clientX - bounds.left) / bounds.width));
    updateControlUI();
    render();
  }

  let lastPaintPoint = null;
  function moveBrushCursor(event) {
    if (!state.depthEditing) return;
    const bounds = artboard.getBoundingClientRect();
    const cursor = $('depthBrushCursor');
    cursor.style.left = `${event.clientX - bounds.left}px`;
    cursor.style.top = `${event.clientY - bounds.top}px`;
    cursor.hidden = false;
  }

  function paintDepth(event) {
    const bounds = artboard.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width * depthCanvas.width;
    const y = (event.clientY - bounds.top) / bounds.height * depthCanvas.height;
    const radius = Math.max(2, Math.min(depthCanvas.width, depthCanvas.height) * state.brushSize / 200);
    const start = lastPaintPoint || { x, y };
    const distance = Math.hypot(x - start.x, y - start.y);
    const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius * 0.35)));
    const channel = state.brushMode === 'near' ? 255 : 0;
    for (let index = 1; index <= steps; index++) {
      const cx = start.x + (x - start.x) * index / steps;
      const cy = start.y + (y - start.y) * index / steps;
      const gradient = depthContext.createRadialGradient(cx, cy, 0, cx, cy, radius);
      gradient.addColorStop(0, `rgba(${channel},${channel},${channel},0.75)`);
      gradient.addColorStop(0.6, `rgba(${channel},${channel},${channel},0.46)`);
      gradient.addColorStop(1, `rgba(${channel},${channel},${channel},0)`);
      depthContext.fillStyle = gradient;
      depthContext.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    }
    lastPaintPoint = { x, y };
    uploadDepthMap();
    render();
  }

  sliderIds.forEach(id => $(id).addEventListener('input', event => {
    state[id] = Number(event.target.value);
    updateControlUI();
    render();
  }));
  document.querySelectorAll('[data-temperature]').forEach(button => button.addEventListener('click', () => {
    state.temperature = Number(button.dataset.temperature);
    updateControlUI();
    render();
  }));
  document.querySelectorAll('[data-cast-preset]').forEach(button => button.addEventListener('click', () => {
    Object.assign(state, castPresets[button.dataset.castPreset]);
    updateControlUI();
    render();
  }));
  $('resetButton').addEventListener('click', () => {
    Object.assign(state, defaults, { compare: false, before: false, depthPreview: false, normalPreview: false, split: 0.5 });
    state.depthEditing = false;
    state.brushMode = 'near';
    state.brushSize = 10;
    resetDepthMap();
    updateControlUI();
    render();
    showToast('調整をリセットしました');
  });
  $('openButton').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { loadFile(fileInput.files[0]); fileInput.value = ''; });
  $('depthEditButton').addEventListener('click', () => {
    if (!state.image || state.depthBusy) return;
    state.depthEditing = !state.depthEditing;
    state.depthPreview = false;
    state.normalPreview = false;
    state.compare = false;
    state.before = false;
    lastPaintPoint = null;
    updateControlUI();
    render();
  });
  $('nearButton').addEventListener('click', () => { state.brushMode = 'near'; updateControlUI(); });
  $('farButton').addEventListener('click', () => { state.brushMode = 'far'; updateControlUI(); });
  $('depthResetButton').addEventListener('click', () => { resetDepthMap(); showToast('推定結果に戻しました'); });
  $('depthReestimateButton').addEventListener('click', estimateDepth);
  $('depthViewButton').addEventListener('click', () => {
    if (state.depthBusy || !state.hasEstimatedDepth) return;
    state.depthPreview = !state.depthPreview;
    state.normalPreview = false;
    state.depthEditing = false;
    state.compare = false;
    state.before = false;
    updateControlUI();
    render();
  });
  $('normalViewButton').addEventListener('click', () => {
    if (!state.image) return;
    state.normalPreview = !state.normalPreview;
    state.depthEditing = false;
    state.depthPreview = false;
    state.compare = false;
    state.before = false;
    updateControlUI();
    render();
  });

  let pointerMode = null;
  artboard.addEventListener('pointerdown', event => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    if (state.depthPreview || state.normalPreview) return;
    pointerMode = state.depthEditing ? 'depth' : state.compare ? 'split' : 'light';
    artboard.setPointerCapture(event.pointerId);
    if (pointerMode === 'split') setSplitFromEvent(event);
    else if (pointerMode === 'depth') { lastPaintPoint = null; moveBrushCursor(event); paintDepth(event); }
    else setLightFromEvent(event, artboard);
  });
  artboard.addEventListener('pointermove', event => {
    moveBrushCursor(event);
    if (!pointerMode) return;
    if (pointerMode === 'split') setSplitFromEvent(event);
    else if (pointerMode === 'depth') paintDepth(event);
    else setLightFromEvent(event, artboard);
  });
  const releasePointer = event => {
    if (pointerMode === 'depth') scheduleNormalMapUpdate();
    pointerMode = null;
    lastPaintPoint = null;
    if (event.pointerType === 'touch') $('depthBrushCursor').hidden = true;
  };
  artboard.addEventListener('pointerup', releasePointer);
  artboard.addEventListener('pointercancel', releasePointer);
  artboard.addEventListener('pointerleave', () => { if (!pointerMode) $('depthBrushCursor').hidden = true; });

  const miniMap = $('miniMap');
  let movingMiniMap = false;
  miniMap.addEventListener('pointerdown', event => { movingMiniMap = true; miniMap.setPointerCapture(event.pointerId); setLightFromEvent(event, miniMap); });
  miniMap.addEventListener('pointermove', event => { if (movingMiniMap) setLightFromEvent(event, miniMap); });
  miniMap.addEventListener('pointerup', () => { movingMiniMap = false; });
  miniMap.addEventListener('pointercancel', () => { movingMiniMap = false; });
  miniMap.addEventListener('keydown', event => {
    const step = event.shiftKey ? 0.1 : 0.02;
    if (event.key === 'ArrowLeft') state.x -= step;
    else if (event.key === 'ArrowRight') state.x += step;
    else if (event.key === 'ArrowUp') state.y -= step;
    else if (event.key === 'ArrowDown') state.y += step;
    else return;
    event.preventDefault();
    state.x = Math.max(0, Math.min(1, state.x));
    state.y = Math.max(0, Math.min(1, state.y));
    updateControlUI();
    render();
  });

  $('compareButton').addEventListener('click', () => { if (state.depthEditing || state.depthPreview || state.normalPreview) return; state.compare = !state.compare; state.before = false; updateControlUI(); render(); });
  const beforeButton = $('beforeButton');
  const showBefore = () => { if (state.depthEditing || state.depthPreview || state.normalPreview) return; state.before = true; updateControlUI(); render(); };
  const hideBefore = () => { state.before = false; updateControlUI(); render(); };
  beforeButton.addEventListener('pointerdown', event => { beforeButton.setPointerCapture(event.pointerId); showBefore(); });
  beforeButton.addEventListener('pointerup', hideBefore);
  beforeButton.addEventListener('pointercancel', hideBefore);
  beforeButton.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') showBefore(); });
  beforeButton.addEventListener('keyup', hideBefore);
  document.addEventListener('keydown', event => {
    if (event.code === 'Space' && !['INPUT', 'BUTTON'].includes(document.activeElement.tagName)) { event.preventDefault(); showBefore(); }
  });
  document.addEventListener('keyup', event => { if (event.code === 'Space') hideBefore(); });

  let dragDepth = 0;
  document.addEventListener('dragenter', event => { event.preventDefault(); dragDepth++; stage.classList.add('dragover'); });
  document.addEventListener('dragleave', event => { event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) stage.classList.remove('dragover'); });
  document.addEventListener('dragover', event => event.preventDefault());
  document.addEventListener('drop', event => {
    event.preventDefault(); dragDepth = 0; stage.classList.remove('dragover');
    loadFile(event.dataTransfer.files[0]);
  });

  $('exportButton').addEventListener('click', () => {
    if (!state.image) return;
    const previousCompare = state.compare;
    const previousBefore = state.before;
    const previousDepthEditing = state.depthEditing;
    const previousDepthPreview = state.depthPreview;
    const previousNormalPreview = state.normalPreview;
    state.compare = false;
    state.before = false;
    state.depthEditing = false;
    state.depthPreview = false;
    state.normalPreview = false;
    render();
    canvas.toBlob(blob => {
      state.compare = previousCompare;
      state.before = previousBefore;
      state.depthEditing = previousDepthEditing;
      state.depthPreview = previousDepthPreview;
      state.normalPreview = previousNormalPreview;
      render();
      if (!blob) { showToast('PNGを書き出せませんでした'); return; }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${state.imageName || 'illustration'}-lumiere.png`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('PNGを書き出しました');
    }, 'image/png');
  });

  window.addEventListener('resize', fitArtboard);
  new ResizeObserver(fitArtboard).observe(document.querySelector('.stage-center'));
  updateControlUI();
  const sample = new Image();
  sample.onload = () => setImage(sample, 'サンプルイラスト');
  sample.onerror = () => showToast('サンプルイラストを読み込めませんでした');
  sample.src = './assets/demo-illustration.svg';
})();
