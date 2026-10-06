(() => {
  'use strict';

  const MAX_LIGHTS = 4;
  const lightKeys = ['x', 'y', 'intensity', 'spread', 'lightHeight', 'temperature', 'backlight'];
  const lightDefaults = { x: 0.68, y: 0.31, intensity: 80, spread: 65, lightHeight: 55, temperature: 5500, backlight: false };
  const defaults = { ...lightDefaults, relief: 35, normalStrength: 100, shadow: 40, contactStrength: 35, gloss: 18, roughness: 70, metallic: 0, materialAuto: true, depthStrength: 45, castStrength: 0, castSoftness: 70 };
  const state = { ...defaults, lights: [{ ...lightDefaults }], selectedLightIndex: 0, compare: false, before: false, depthPreview: false, normalPreview: false, materialPreview: false, split: 0.5, image: null, imageName: 'サンプルイラスト', depthEditing: false, depthBusy: false, hasEstimatedDepth: false, materialBusy: false, hasEstimatedMaterial: false, brushMode: 'near', brushSize: 10 };
  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const artboard = $('artboard');
  const stage = $('dropZone');
  const fileInput = $('fileInput');
  const sliderIds = ['intensity', 'spread', 'lightHeight', 'temperature', 'relief', 'normalStrength', 'shadow', 'contactStrength', 'gloss', 'roughness', 'metallic', 'depthStrength', 'castStrength', 'castSoftness', 'brushSize'];
  const materialControlIds = new Set(['gloss', 'roughness', 'metallic']);
  const castPresets = { natural: { castStrength: 0, castSoftness: 70 }, soft: { castStrength: 38, castSoftness: 78 }, dramatic: { castStrength: 90, castSoftness: 20 } };
  const materialPresets = { matte: { gloss: 18, roughness: 70, metallic: 0 }, satin: { gloss: 55, roughness: 45, metallic: 0 }, metal: { gloss: 85, roughness: 22, metallic: 90 } };
  const depthCanvas = document.createElement('canvas');
  const depthContext = depthCanvas.getContext('2d');
  const estimatedDepthCanvas = document.createElement('canvas');
  const estimatedDepthContext = estimatedDepthCanvas.getContext('2d');
  const normalCanvas = document.createElement('canvas');
  const normalContext = normalCanvas.getContext('2d');
  const normalDepthCanvas = document.createElement('canvas');
  const normalDepthContext = normalDepthCanvas.getContext('2d');
  const materialCanvas = document.createElement('canvas');
  const materialContext = materialCanvas.getContext('2d');
  const materialInputCanvas = document.createElement('canvas');
  const materialInputContext = materialInputCanvas.getContext('2d', { willReadFrequently: true });
  let normalUpdateQueued = false;
  let normalWasm = null;
  let estimatorPromise = null;
  let materialSegmenterPromise = null;
  let inferenceQueue = Promise.resolve();
  let depthGeneration = 0;
  let materialGeneration = 0;
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
    uniform sampler2D uMaterialMap;
    uniform vec2 uTexel;
    uniform vec4 uLightGeometry[${MAX_LIGHTS}];
    uniform vec3 uLightAppearance[${MAX_LIGHTS}];
    uniform int uLightCount;
    uniform float uRelief;
    uniform float uNormalStrength;
    uniform float uShadow;
    uniform float uContactStrength;
    uniform float uGloss;
    uniform float uRoughness;
    uniform float uMetallic;
    uniform float uMaterialAuto;
    uniform float uDepthStrength;
    uniform float uCastStrength;
    uniform float uCastSoftness;
    uniform float uShowDepth;
    uniform float uShowNormal;
    uniform float uShowMaterial;
    uniform float uAspect;
    uniform float uCompare;
    uniform float uBefore;
    uniform float uSplit;

    float heightAt(vec2 uv) {
      vec4 p = texture2D(uImage, clamp(uv, vec2(0.0), vec2(1.0)));
      return dot(p.rgb, vec3(0.299, 0.587, 0.114)) * 0.76 + p.a * 0.24;
    }
    float contactSample(vec2 uv, float receiverDepth) {
      float separation = texture2D(uDepthMap, clamp(uv, vec2(0.0), vec2(1.0))).r - receiverDepth;
      return smoothstep(0.018, 0.16, separation) * (1.0 - smoothstep(0.43, 0.76, separation));
    }
    float contactShadowAt(vec2 uv, float receiverDepth) {
      vec2 nearStep = uTexel * 5.0;
      vec2 farStep = uTexel * 15.0;
      float nearby = contactSample(uv + vec2(nearStep.x, 0.0), receiverDepth)
                   + contactSample(uv - vec2(nearStep.x, 0.0), receiverDepth)
                   + contactSample(uv + vec2(0.0, nearStep.y), receiverDepth)
                   + contactSample(uv - vec2(0.0, nearStep.y), receiverDepth);
      float wider = contactSample(uv + vec2(farStep.x, 0.0), receiverDepth)
                  + contactSample(uv - vec2(farStep.x, 0.0), receiverDepth)
                  + contactSample(uv + vec2(0.0, farStep.y), receiverDepth)
                  + contactSample(uv - vec2(0.0, farStep.y), receiverDepth);
      return clamp((nearby * 0.7 + wider * 0.3) / 2.0, 0.0, 1.0);
    }
    float castShadowAt(vec2 uv, float receiverDepth, vec2 lightPosition, float lightDepth) {
      float projection = 1.0 + mix(0.82, 0.12, lightDepth) * mix(0.55, 1.0, uCastStrength);
      vec2 sampleUv = lightPosition + (uv - lightPosition) / projection;
      if (sampleUv.x <= 0.0 || sampleUv.x >= 1.0 || sampleUv.y <= 0.0 || sampleUv.y >= 1.0) return 0.0;
      float blockerDepth = texture2D(uDepthMap, sampleUv).r;
      if (uCastSoftness < 0.01) return smoothstep(0.13, 0.34, blockerDepth - receiverDepth);
      float separation = max(blockerDepth - receiverDepth, 0.0);
      float radius = uCastSoftness * (0.006 + separation * 0.045) * mix(1.2, 0.7, lightDepth);
      vec2 blur = vec2(radius / uAspect, radius);
      vec2 diagonal = blur * 0.7071;
      float cardinal = texture2D(uDepthMap, sampleUv + vec2(blur.x, 0.0)).r
                     + texture2D(uDepthMap, sampleUv - vec2(blur.x, 0.0)).r
                     + texture2D(uDepthMap, sampleUv + vec2(0.0, blur.y)).r
                     + texture2D(uDepthMap, sampleUv - vec2(0.0, blur.y)).r;
      float corners = texture2D(uDepthMap, sampleUv + diagonal).r
                    + texture2D(uDepthMap, sampleUv - diagonal).r
                    + texture2D(uDepthMap, sampleUv + vec2(diagonal.x, -diagonal.y)).r
                    + texture2D(uDepthMap, sampleUv + vec2(-diagonal.x, diagonal.y)).r;
      float blurredDepth = blockerDepth * 0.4 + cardinal * 0.1 + corners * 0.05;
      return smoothstep(0.12, 0.34 + uCastSoftness * 0.05, blurredDepth - receiverDepth);
    }
    float backlightOcclusionAt(vec2 uv, float receiverDepth, vec2 lightPosition, float lightDistance, vec2 edgeStep) {
      vec2 ray = lightPosition - uv;
      float start = clamp(length(edgeStep * 2.0) / max(length(ray), 0.001), 0.08, 0.42);
      // The map is white in front; moving a rear light farther away lowers its depth.
      float lightDepth = 1.0 - lightDistance;
      float leftReceiver = 0.0;
      float occlusion = 0.0;
      for (int stepIndex = 0; stepIndex < 6; stepIndex++) {
        float alongRay = mix(start, 0.92, float(stepIndex) / 5.0);
        float blockerDepth = texture2D(uDepthMap, uv + ray * alongRay).r;
        // Skip the lit surface itself, then test surfaces between it and the light.
        leftReceiver = max(leftReceiver, 1.0 - smoothstep(receiverDepth - 0.1, receiverDepth - 0.03, blockerDepth));
        occlusion = max(occlusion, leftReceiver * smoothstep(0.04, 0.16, blockerDepth - lightDepth));
      }
      return occlusion;
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
      if (uShowMaterial > 0.5) {
        vec3 material = mix(vec3(uGloss, uRoughness, uMetallic), texture2D(uMaterialMap, vUv).rgb, uMaterialAuto);
        vec3 mapColor = mix(vec3(0.42, 0.34, 0.50), vec3(0.44, 0.69, 0.88), smoothstep(0.25, 0.60, material.r));
        mapColor = mix(mapColor, vec3(0.95, 0.70, 0.32), smoothstep(0.25, 0.75, material.b));
        gl_FragColor = vec4(mapColor, source.a);
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
      vec3 material = mix(vec3(uGloss, uRoughness, uMetallic), texture2D(uMaterialMap, vUv).rgb, uMaterialAuto);
      float depthBias = (depth - 0.5) * uDepthStrength;
      float ambient = 1.0 - uShadow * 0.27 + depthBias * 0.38;
      float ambientTemperature = uLightAppearance[0].z > 0.5 ? 5500.0 : uLightAppearance[0].y;
      float warmth = clamp((5500.0 - ambientTemperature) / 3000.0, 0.0, 1.0);
      float coolness = clamp((ambientTemperature - 5500.0) / 3500.0, 0.0, 1.0);
      vec3 tint = vec3(1.0) + warmth * vec3(0.11, 0.005, -0.19) + coolness * vec3(-0.13, -0.025, 0.17);
      vec3 color = source.rgb * max(0.0, ambient) * tint;
      color = mix(color, vec3(dot(color, vec3(0.299, 0.587, 0.114))), (1.0 - depth) * uDepthStrength * 0.08);
      vec3 directColor = vec3(0.0);
      float frontIntensity = 0.0;
      float rearIntensity = 0.0;
      float blockedIntensity = 0.0;
      for (int i = 0; i < ${MAX_LIGHTS}; i++) {
        if (i >= uLightCount) break;
        vec4 light = uLightGeometry[i];
        vec3 appearance = uLightAppearance[i];
        vec2 delta = vec2((light.x - vUv.x) * uAspect, light.y - vUv.y);
        float distanceToLight = length(delta);
        float spread = appearance.x * mix(0.78, 1.18, light.z);
        float falloff = exp(-distanceToLight * distanceToLight / max(0.035, spread * spread * 0.52));
        float lightWarmth = clamp((5500.0 - appearance.y) / 3000.0, 0.0, 1.0);
        float lightCoolness = clamp((appearance.y - 5500.0) / 3500.0, 0.0, 1.0);
        vec3 lightTint = vec3(1.0) + lightWarmth * vec3(0.12, -0.035, -0.22) + lightCoolness * vec3(-0.20, -0.035, 0.19);
        if (appearance.z > 0.5) {
          vec2 edgeStep = uTexel * mix(4.0, 18.0, light.z);
          vec2 xStep = vec2(edgeStep.x, 0.0);
          vec2 yStep = vec2(0.0, edgeStep.y);
          vec4 leftSample = texture2D(uImage, vUv - xStep);
          vec4 rightSample = texture2D(uImage, vUv + xStep);
          vec4 downSample = texture2D(uImage, vUv - yStep);
          vec4 upSample = texture2D(uImage, vUv + yStep);
          float leftDepth = texture2D(uDepthMap, vUv - xStep).r;
          float rightDepth = texture2D(uDepthMap, vUv + xStep).r;
          float downDepth = texture2D(uDepthMap, vUv - yStep).r;
          float upDepth = texture2D(uDepthMap, vUv + yStep).r;
          float depthEdge = max(depth - min(min(leftDepth, rightDepth), min(downDepth, upDepth)), 0.0);
          float alphaEdge = max(source.a - min(min(leftSample.a, rightSample.a), min(downSample.a, upSample.a)), 0.0);
          vec2 outward = vec2(leftDepth - rightDepth + leftSample.a - rightSample.a,
                              downDepth - upDepth + downSample.a - upSample.a);
          float facing = max(dot(normalize(outward + vec2(0.00001)), normalize(delta + vec2(0.00001))), 0.0);
          float rim = smoothstep(0.035, 0.24, max(depthEdge * 1.5, alphaEdge)) * facing;
          if (rim > 0.001) rim *= 1.0 - backlightOcclusionAt(vUv, depth, light.xy, light.z, edgeStep);
          vec3 edgeColor = mix(source.rgb, vec3(1.0), 0.68);
          directColor += edgeColor * lightTint * rim * falloff * light.w * 1.45;
          rearIntensity += light.w;
        } else {
          float surfaceDepth = depth * uDepthStrength * 0.18;
          float heightAboveSurface = max(0.08, mix(0.25, 0.82, light.z) - surfaceDepth);
          vec3 lightDirection = normalize(vec3(delta * 1.3, heightAboveSurface));
          float diffuse = max(dot(normal, lightDirection), 0.0);
          float illumination = light.w * falloff * (0.30 + diffuse * 0.28) * (1.0 + depthBias * 0.9);
          float reliefShade = (diffuse - 0.72) * uRelief * 0.78 * (0.3 + uShadow * 0.7) * falloff * light.w;
          vec3 contribution = source.rgb * (illumination + reliefShade) * lightTint * (1.0 - material.b * 0.42);
          vec3 halfVector = normalize(lightDirection + vec3(0.0, 0.0, 1.0));
          float shininess = mix(110.0, 3.0, material.g * material.g);
          float highlight = pow(max(dot(normal, halfVector), 0.0), shininess) * diffuse;
          float reflection = material.r * mix(0.42, 0.09, material.g) * mix(1.0, 2.0, material.b);
          vec3 reflectionColor = mix(vec3(1.0), vec3(0.18) + source.rgb * 0.82, material.b);
          contribution += reflectionColor * lightTint * highlight * reflection * falloff * light.w;
          frontIntensity += light.w;
          if (uCastStrength > 0.001) {
            float occlusion = castShadowAt(vUv, depth, light.xy, light.z);
            blockedIntensity += occlusion * light.w;
            contribution *= 1.0 - occlusion * uCastStrength * (0.64 + uShadow * 0.25);
          }
          directColor += contribution;
        }
      }
      float rearShare = rearIntensity / max(frontIntensity + rearIntensity, 0.001);
      color = color * (1.0 - rearShare * 0.24)
            * (1.0 - blockedIntensity / max(frontIntensity, 0.001) * uCastStrength * (0.64 + uShadow * 0.25))
            + directColor;
      if (uContactStrength > 0.001) color *= 1.0 - contactShadowAt(vUv, depth) * uContactStrength * 0.52;
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

  let gl, program, texture, depthTexture, normalTexture, materialTexture, uniforms;
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
    materialTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, materialTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([46, 179, 0, 255]));
    gl.activeTexture(gl.TEXTURE0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    uniforms = Object.fromEntries(['uImage', 'uDepthMap', 'uNormalMap', 'uMaterialMap', 'uTexel', 'uLightCount', 'uRelief', 'uNormalStrength', 'uShadow', 'uContactStrength', 'uGloss', 'uRoughness', 'uMetallic', 'uMaterialAuto', 'uDepthStrength', 'uCastStrength', 'uCastSoftness', 'uShowDepth', 'uShowNormal', 'uShowMaterial', 'uAspect', 'uCompare', 'uBefore', 'uSplit'].map(name => [name, gl.getUniformLocation(program, name)]));
    uniforms.uLightGeometry = gl.getUniformLocation(program, 'uLightGeometry[0]');
    uniforms.uLightAppearance = gl.getUniformLocation(program, 'uLightAppearance[0]');
    gl.uniform1i(uniforms.uImage, 0);
    gl.uniform1i(uniforms.uDepthMap, 1);
    gl.uniform1i(uniforms.uNormalMap, 2);
    gl.uniform1i(uniforms.uMaterialMap, 3);
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

  function selectedLight() {
    return state.lights[state.selectedLightIndex];
  }

  function syncSelectedLight() {
    const light = selectedLight();
    for (const key of lightKeys) state[key] = light[key];
  }

  function saveSelectedLight() {
    const light = selectedLight();
    for (const key of lightKeys) light[key] = state[key];
  }

  function selectLight(index) {
    if (index < 0 || index >= state.lights.length) return;
    state.selectedLightIndex = index;
    syncSelectedLight();
    updateControlUI();
    render();
  }

  function updateLightUI() {
    const list = $('lightList');
    if (list.children.length !== state.lights.length) {
      list.replaceChildren(...state.lights.map((_, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'light-item';
        button.dataset.lightIndex = index;
        const dot = document.createElement('span');
        dot.className = 'light-item-dot';
        const label = document.createElement('span');
        label.textContent = `光源 ${index + 1}`;
        const value = document.createElement('small');
        value.className = 'light-item-value';
        button.append(dot, label, value);
        return button;
      }));
    }
    $('lightCount').textContent = `${state.lights.length} / ${MAX_LIGHTS}`;
    $('addLightButton').disabled = state.lights.length >= MAX_LIGHTS;
    $('removeLightButton').disabled = state.lights.length <= 1;
    const miniDots = $('otherMiniDots');
    const otherHandles = $('otherLightHandles');
    miniDots.replaceChildren();
    otherHandles.replaceChildren();
    state.lights.forEach((light, index) => {
      const button = list.children[index];
      const active = index === state.selectedLightIndex;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
      button.querySelector('.light-item-value').textContent = `${light.backlight ? '逆光 ' : ''}${light.intensity}%`;
      button.querySelector('.light-item-dot').style.background = light.temperature < 5000 ? '#e7a46f' : light.temperature > 6500 ? '#a8c6ed' : '#e9dfc6';
      if (active) return;
      const miniDot = document.createElement('span');
      miniDot.className = 'other-mini-dot';
      miniDot.classList.toggle('backlight', light.backlight);
      miniDot.style.left = `${light.x * 100}%`;
      miniDot.style.top = `${light.y * 100}%`;
      miniDots.append(miniDot);
      const handle = document.createElement('span');
      handle.className = 'light-handle secondary';
      handle.classList.toggle('backlight', light.backlight);
      handle.style.left = `${light.x * 100}%`;
      handle.style.top = `${light.y * 100}%`;
      handle.textContent = String(index + 1);
      otherHandles.append(handle);
    });
    otherHandles.hidden = state.compare || state.before || state.depthEditing || state.depthPreview || state.normalPreview || state.materialPreview;
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
    let generatedWithWasm = false;
    if (normalWasm) {
      try {
        const count = width * height * 4;
        const input = new Uint8Array(normalWasm.memory.buffer, normalWasm.input_ptr(), count);
        input.set(depthPixels);
        if (normalWasm.generate_normals(width, height) === 1) {
          pixels.set(new Uint8Array(normalWasm.memory.buffer, normalWasm.output_ptr(), count));
          generatedWithWasm = true;
        }
      } catch (error) {
        console.warn('法線マップのWASM処理を使えませんでした', error);
        normalWasm = null;
        document.documentElement.dataset.normalEngine = 'javascript';
      }
    }
    if (!generatedWithWasm) {
      const depthAt = (x, y) => depthPixels[(Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))) * 4] / 255;
      const boundedDepthAt = (x, y, center) => {
        const sample = depthAt(x, y);
        const difference = sample - center;
        const transition = Math.max(0, Math.min(1, (Math.abs(difference) - 0.12) / 0.20));
        return center + difference * (1 - transition * transition * (3 - 2 * transition));
      };
      const axisSlope = (x, y, radius, center) => {
        const cross = Math.max(1, Math.floor(radius / 4));
        const left = (boundedDepthAt(x - radius, y - cross, center) + boundedDepthAt(x - radius, y, center) + boundedDepthAt(x - radius, y + cross, center)) / 3;
        const right = (boundedDepthAt(x + radius, y - cross, center) + boundedDepthAt(x + radius, y, center) + boundedDepthAt(x + radius, y + cross, center)) / 3;
        const below = (boundedDepthAt(x - cross, y + radius, center) + boundedDepthAt(x, y + radius, center) + boundedDepthAt(x + cross, y + radius, center)) / 3;
        const above = (boundedDepthAt(x - cross, y - radius, center) + boundedDepthAt(x, y - radius, center) + boundedDepthAt(x + cross, y - radius, center)) / 3;
        return [left - right, below - above];
      };
      const size = Math.min(width, height);
      const roundRadius = Math.max(8, Math.floor(size * 5 / 100));
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const center = depthAt(x, y);
          const fine = axisSlope(x, y, 4, center);
          const round = axisSlope(x, y, roundRadius, center);
          const nx = fine[0] * 0.75 + round[0] * 5.6 * center;
          const ny = fine[1] * 0.75 + round[1] * 5.6 * center;
          const length = Math.hypot(nx, ny, 1);
          const index = (y * width + x) * 4;
          pixels[index] = Math.round((nx / length * 0.5 + 0.5) * 255);
          pixels[index + 1] = Math.round((ny / length * 0.5 + 0.5) * 255);
          pixels[index + 2] = Math.round((1 / length * 0.5 + 0.5) * 255);
          pixels[index + 3] = 255;
        }
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

  async function loadNormalWasm() {
    try {
      const response = await fetch('./normal-map.wasm?v=round-normals-1');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
      normalWasm = instance.exports;
      document.documentElement.dataset.normalEngine = 'wasm';
      scheduleNormalMapUpdate();
    } catch (error) {
      document.documentElement.dataset.normalEngine = 'javascript';
      console.warn('法線マップはJavaScriptで計算します', error);
    }
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

  function setMaterialStatus(message, kind = '') {
    const status = $('materialStatus');
    status.textContent = message;
    status.className = `depth-status ${kind}`;
  }

  function buildMaterialMap(segments = []) {
    if (!state.image) return [];
    const scale = Math.min(1, 512 / Math.max(canvas.width, canvas.height));
    const width = materialCanvas.width = materialInputCanvas.width = Math.max(1, Math.round(canvas.width * scale));
    const height = materialCanvas.height = materialInputCanvas.height = Math.max(1, Math.round(canvas.height * scale));
    materialInputContext.clearRect(0, 0, width, height);
    materialInputContext.fillStyle = '#ffffff';
    materialInputContext.fillRect(0, 0, width, height);
    materialInputContext.drawImage(state.image, 0, 0, width, height);
    const source = materialInputContext.getImageData(0, 0, width, height).data;
    const result = materialContext.createImageData(width, height);
    const luminance = new Float32Array(width * height);
    for (let index = 0; index < luminance.length; index++) {
      const offset = index * 4;
      luminance[index] = (source[offset] * 0.299 + source[offset + 1] * 0.587 + source[offset + 2] * 0.114) / 255;
    }
    const sampleLuma = (x, y) => luminance[Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        const offset = index * 4;
        const red = source[offset] / 255;
        const green = source[offset + 1] / 255;
        const blue = source[offset + 2] / 255;
        const saturation = Math.max(red, green, blue) - Math.min(red, green, blue);
        const nearby = (sampleLuma(x - 6, y) + sampleLuma(x + 6, y) + sampleLuma(x, y - 6) + sampleLuma(x, y + 6)) * 0.25;
        const brightDetail = Math.max(0, Math.min(1, (luminance[index] - nearby - 0.09) * 3.5));
        const reflective = brightDetail * (1 - saturation * 0.65) * Math.max(0, Math.min(1, (luminance[index] - 0.48) * 3));
        const darkSmooth = Math.max(0, Math.min(1, (0.55 - luminance[index]) * 3))
          * Math.max(0, Math.min(1, (blue - red) * 20));
        result.data[offset] = Math.round((0.18 + darkSmooth * 0.32 + reflective * 0.50) * 255);
        result.data[offset + 1] = Math.round((0.70 - darkSmooth * 0.23 - reflective * 0.46) * 255);
        result.data[offset + 2] = Math.round(reflective * 0.60 * 255);
        result.data[offset + 3] = 255;
      }
    }

    const materials = {
      Hair: [0.55, 0.43, 0],
      Face: [0.09, 0.82, 0],
      'Left-arm': [0.09, 0.82, 0], 'Right-arm': [0.09, 0.82, 0],
      'Left-leg': [0.09, 0.82, 0], 'Right-leg': [0.09, 0.82, 0],
      'Upper-clothes': [0.16, 0.78, 0], Skirt: [0.16, 0.78, 0],
      Pants: [0.16, 0.78, 0], Dress: [0.16, 0.78, 0], Scarf: [0.16, 0.78, 0],
      Sunglasses: [0.72, 0.22, 0.60],
      Belt: [0.36, 0.54, 0.12], Bag: [0.32, 0.60, 0.08],
      'Left-shoe': [0.33, 0.56, 0.05], 'Right-shoe': [0.33, 0.56, 0.05],
    };
    const detected = [];
    for (const segment of segments) {
      const values = materials[segment.label];
      const mask = segment.mask;
      if (!values || !mask?.data || !mask.width || !mask.height) continue;
      const channels = mask.channels || 1;
      let painted = 0;
      for (let y = 0; y < height; y++) {
        const maskY = Math.min(mask.height - 1, Math.floor(y * mask.height / height));
        for (let x = 0; x < width; x++) {
          const maskX = Math.min(mask.width - 1, Math.floor(x * mask.width / width));
          if (mask.data[(maskY * mask.width + maskX) * channels] < 128) continue;
          const offset = (y * width + x) * 4;
          result.data[offset] = Math.round(values[0] * 255);
          result.data[offset + 1] = Math.round(values[1] * 255);
          result.data[offset + 2] = Math.round(values[2] * 255);
          painted++;
        }
      }
      if (painted > width * height * 0.005) detected.push(segment.label);
    }
    materialContext.putImageData(result, 0, 0);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, materialTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, materialCanvas);
    gl.activeTexture(gl.TEXTURE0);
    state.hasEstimatedMaterial = true;
    updateControlUI();
    render();
    return detected;
  }

  async function getMaterialSegmenter() {
    if (!materialSegmenterPromise) {
      materialSegmenterPromise = import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1')
        .then(async ({ pipeline, env }) => {
          env.allowLocalModels = false;
          env.useBrowserCache = true;
          return pipeline('image-segmentation', 'Xenova/segformer_b0_clothes', {
            dtype: 'q8',
            progress_callback: progress => {
              if (state.materialBusy && progress.status === 'progress' && Number.isFinite(progress.progress)) {
                setMaterialStatus(`領域モデルを取得中 ${Math.round(progress.progress)}%`, 'loading');
              }
            },
          });
        })
        .catch(error => { materialSegmenterPromise = null; throw error; });
    }
    return materialSegmenterPromise;
  }

  function estimateMaterials() {
    if (!state.image) return;
    const generation = ++materialGeneration;
    const image = state.image;
    state.materialBusy = true;
    setMaterialStatus('画像の領域を解析中…', 'loading');
    updateControlUI();
    inferenceQueue = inferenceQueue.catch(() => {}).then(async () => {
      try {
        if (generation !== materialGeneration) return;
        const segmenter = await getMaterialSegmenter();
        if (generation !== materialGeneration) return;
        const input = document.createElement('canvas');
        const scale = Math.min(1, 512 / Math.max(canvas.width, canvas.height));
        input.width = Math.max(1, Math.round(canvas.width * scale));
        input.height = Math.max(1, Math.round(canvas.height * scale));
        const context = input.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, input.width, input.height);
        context.drawImage(image, 0, 0, input.width, input.height);
        setMaterialStatus('髪・肌・衣服などを判定中…', 'loading');
        const segments = await segmenter(input);
        if (generation !== materialGeneration) return;
        const detected = buildMaterialMap(segments);
        state.materialBusy = false;
        const names = { Hair: '髪', Face: '肌', 'Left-arm': '肌', 'Right-arm': '肌', 'Left-leg': '肌', 'Right-leg': '肌', 'Upper-clothes': '衣服', Skirt: '衣服', Pants: '衣服', Dress: '衣服', Scarf: '衣服', Sunglasses: '眼鏡', Belt: '小物', Bag: '小物', 'Left-shoe': '靴', 'Right-shoe': '靴' };
        const regions = [...new Set(detected.map(label => names[label]).filter(Boolean))];
        setMaterialStatus(regions.length ? `${regions.join('・')}を検出して材質を推定しました` : '色とハイライトから材質を推定しました', 'ready');
        updateControlUI();
      } catch (error) {
        console.warn('領域モデルを使えないため、画像の見た目から材質を推定します', error);
        if (generation !== materialGeneration) return;
        state.materialBusy = false;
        setMaterialStatus('色とハイライトから材質を推定しました', 'ready');
        updateControlUI();
      }
    });
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
    for (const [id, active] of [['frontLightButton', !state.backlight], ['backLightButton', state.backlight]]) {
      $(id).classList.toggle('active', active);
      $(id).setAttribute('aria-pressed', String(active));
    }
    $('lightDepthFarLabel').textContent = state.backlight ? '背後に離す' : '手前に離す';
    $('lightDepthNote').textContent = state.backlight ? '背後に離すほど輪郭が広がり、手前の層に遮られやすくなります。' : '画像面に近いほど落ち影が長くなります。';
    document.querySelectorAll('[data-cast-preset]').forEach(button => {
      const preset = castPresets[button.dataset.castPreset];
      button.classList.toggle('active', state.castStrength === preset.castStrength && state.castSoftness === preset.castSoftness);
    });
    document.querySelectorAll('[data-material-preset]').forEach(button => {
      const preset = materialPresets[button.dataset.materialPreset];
      button.classList.toggle('active', !state.materialAuto && state.gloss === preset.gloss && state.roughness === preset.roughness && state.metallic === preset.metallic);
    });
    $('materialAutoButton').classList.toggle('active', state.materialAuto);
    $('materialAutoButton').setAttribute('aria-pressed', String(state.materialAuto));
    $('materialSection').classList.toggle('material-auto-active', state.materialAuto);
    $('materialReestimateButton').disabled = state.materialBusy || !state.image;
    updateLightUI();
    $('miniMapDot').style.left = `${state.x * 100}%`;
    $('miniMapDot').style.top = `${state.y * 100}%`;
    $('miniMapDot').classList.toggle('backlight', state.backlight);
    $('miniMap').setAttribute('aria-valuenow', String(Math.round(state.x * 100)));
    $('miniMap').setAttribute('aria-valuetext', `横 ${Math.round(state.x * 100)}%、縦 ${Math.round(state.y * 100)}%`);
    $('lightHandle').style.left = `${state.x * 100}%`;
    $('lightHandle').style.top = `${state.y * 100}%`;
    $('lightHandle').classList.toggle('backlight', state.backlight);
    $('lightHandle').style.opacity = state.compare || state.before || state.depthEditing || state.depthPreview || state.normalPreview || state.materialPreview ? '0' : '1';
    $('splitLine').hidden = !state.compare;
    $('splitLine').style.left = `${state.split * 100}%`;
    $('beforeCaption').hidden = !state.compare;
    $('afterCaption').hidden = !state.compare;
    $('compareButton').classList.toggle('active', state.compare);
    $('compareButton').setAttribute('aria-pressed', String(state.compare));
    $('beforeButton').classList.toggle('active', state.before);
    $('beforeButton').setAttribute('aria-pressed', String(state.before));
    $('compareButton').disabled = state.depthEditing || state.depthPreview || state.normalPreview || state.materialPreview;
    $('beforeButton').disabled = state.depthEditing || state.depthPreview || state.normalPreview || state.materialPreview;
    $('depthViewButton').classList.toggle('active', state.depthPreview);
    $('depthViewButton').setAttribute('aria-pressed', String(state.depthPreview));
    $('depthViewButton').disabled = state.depthBusy || !state.hasEstimatedDepth;
    $('normalViewButton').classList.toggle('active', state.normalPreview);
    $('normalViewButton').setAttribute('aria-pressed', String(state.normalPreview));
    $('normalViewButton').disabled = !state.image;
    $('materialViewButton').classList.toggle('active', state.materialPreview);
    $('materialViewButton').setAttribute('aria-pressed', String(state.materialPreview));
    $('materialViewButton').disabled = !state.hasEstimatedMaterial;
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
    artboard.classList.toggle('material-preview', state.materialPreview);
    if (!state.depthEditing) $('depthBrushCursor').hidden = true;
    const brushDiameter = Math.min(artboard.clientWidth, artboard.clientHeight) * state.brushSize / 100;
    $('depthBrushCursor').style.width = `${brushDiameter}px`;
    $('depthBrushCursor').style.height = `${brushDiameter}px`;
    $('stageTip').textContent = state.depthEditing ? '白＝手前、黒＝奥。イラスト上をなぞって深度を指定' : state.depthPreview ? '深度マップを表示中：白＝手前、黒＝奥' : state.normalPreview ? '法線マップを表示中：色が面の向きを表します' : state.materialPreview ? '材質マップ：紫＝マット、青＝光沢、黄＝金属感' : state.compare ? '境界線をドラッグして調整前後を比較' : '選択した光源をクリック・ドラッグして移動';
  }

  function render() {
    if (!state.image) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uniforms.uTexel, 1 / canvas.width, 1 / canvas.height);
    const lightGeometry = new Float32Array(MAX_LIGHTS * 4);
    const lightAppearance = new Float32Array(MAX_LIGHTS * 3);
    state.lights.forEach((light, index) => {
      lightGeometry.set([light.x, 1 - light.y, light.lightHeight / 100, light.intensity / 100], index * 4);
      lightAppearance.set([light.spread / 100, light.temperature, Number(light.backlight)], index * 3);
    });
    gl.uniform4fv(uniforms.uLightGeometry, lightGeometry);
    gl.uniform3fv(uniforms.uLightAppearance, lightAppearance);
    gl.uniform1i(uniforms.uLightCount, state.lights.length);
    gl.uniform1f(uniforms.uRelief, state.relief / 100);
    gl.uniform1f(uniforms.uNormalStrength, state.normalStrength / 100);
    gl.uniform1f(uniforms.uShadow, state.shadow / 100);
    gl.uniform1f(uniforms.uContactStrength, state.contactStrength / 100);
    gl.uniform1f(uniforms.uGloss, state.gloss / 100);
    gl.uniform1f(uniforms.uRoughness, state.roughness / 100);
    gl.uniform1f(uniforms.uMetallic, state.metallic / 100);
    gl.uniform1f(uniforms.uMaterialAuto, Number(state.materialAuto));
    gl.uniform1f(uniforms.uDepthStrength, state.depthStrength / 100);
    gl.uniform1f(uniforms.uCastStrength, state.castStrength / 100);
    gl.uniform1f(uniforms.uCastSoftness, state.castSoftness / 100);
    gl.uniform1f(uniforms.uShowDepth, Number(state.depthEditing || state.depthPreview));
    gl.uniform1f(uniforms.uShowNormal, Number(state.normalPreview));
    gl.uniform1f(uniforms.uShowMaterial, Number(state.materialPreview));
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
    state.materialAuto = true;
    state.depthEditing = false;
    state.depthPreview = false;
    state.normalPreview = false;
    state.materialPreview = false;
    state.hasEstimatedDepth = false;
    state.hasEstimatedMaterial = false;
    state.compare = false;
    state.before = false;
    $('projectName').textContent = name;
    $('canvasTitle').textContent = name;
    $('imageSize').textContent = `${width} × ${height} px`;
    initializeDepthMap();
    buildMaterialMap();
    updateControlUI();
    fitArtboard();
    render();
    estimateDepth();
    estimateMaterials();
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
    saveSelectedLight();
    updateControlUI();
    render();
  }

  function selectNearbyLight(event, target, radius) {
    const bounds = target.getBoundingClientRect();
    let nearest = -1;
    let nearestDistance = radius;
    state.lights.forEach((light, index) => {
      const distance = Math.hypot(event.clientX - bounds.left - light.x * bounds.width, event.clientY - bounds.top - light.y * bounds.height);
      if (distance < nearestDistance) {
        nearest = index;
        nearestDistance = distance;
      }
    });
    if (nearest >= 0 && nearest !== state.selectedLightIndex) selectLight(nearest);
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
    if (materialControlIds.has(id)) state.materialAuto = false;
    if (lightKeys.includes(id)) saveSelectedLight();
    updateControlUI();
    render();
  }));
  document.querySelectorAll('[data-temperature]').forEach(button => button.addEventListener('click', () => {
    state.temperature = Number(button.dataset.temperature);
    saveSelectedLight();
    updateControlUI();
    render();
  }));
  for (const [id, backlight] of [['frontLightButton', false], ['backLightButton', true]]) {
    $(id).addEventListener('click', () => {
      state.backlight = backlight;
      saveSelectedLight();
      updateControlUI();
      render();
    });
  }
  $('lightList').addEventListener('click', event => {
    const button = event.target.closest('[data-light-index]');
    if (button) selectLight(Number(button.dataset.lightIndex));
  });
  $('addLightButton').addEventListener('click', () => {
    if (state.lights.length >= MAX_LIGHTS) return;
    const current = selectedLight();
    state.lights.push({ ...current, x: Math.max(0.08, Math.min(0.92, current.x - 0.23)), y: Math.max(0.08, Math.min(0.92, current.y + 0.13)), intensity: 25 });
    selectLight(state.lights.length - 1);
  });
  $('removeLightButton').addEventListener('click', () => {
    if (state.lights.length <= 1) return;
    state.lights.splice(state.selectedLightIndex, 1);
    selectLight(Math.min(state.selectedLightIndex, state.lights.length - 1));
  });
  document.querySelectorAll('[data-cast-preset]').forEach(button => button.addEventListener('click', () => {
    Object.assign(state, castPresets[button.dataset.castPreset]);
    updateControlUI();
    render();
  }));
  document.querySelectorAll('[data-material-preset]').forEach(button => button.addEventListener('click', () => {
    Object.assign(state, materialPresets[button.dataset.materialPreset]);
    state.materialAuto = false;
    updateControlUI();
    render();
  }));
  $('materialAutoButton').addEventListener('click', () => {
    state.materialAuto = true;
    updateControlUI();
    render();
  });
  $('materialReestimateButton').addEventListener('click', estimateMaterials);
  $('resetButton').addEventListener('click', () => {
    Object.assign(state, defaults, { compare: false, before: false, depthPreview: false, normalPreview: false, materialPreview: false, split: 0.5 });
    state.lights = [{ ...lightDefaults }];
    state.selectedLightIndex = 0;
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
    state.materialPreview = false;
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
    state.materialPreview = false;
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
    state.materialPreview = false;
    state.compare = false;
    state.before = false;
    updateControlUI();
    render();
  });
  $('materialViewButton').addEventListener('click', () => {
    if (!state.hasEstimatedMaterial) return;
    state.materialPreview = !state.materialPreview;
    state.depthEditing = false;
    state.depthPreview = false;
    state.normalPreview = false;
    state.compare = false;
    state.before = false;
    updateControlUI();
    render();
  });

  let pointerMode = null;
  artboard.addEventListener('pointerdown', event => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    if (state.depthPreview || state.normalPreview || state.materialPreview) return;
    pointerMode = state.depthEditing ? 'depth' : state.compare ? 'split' : 'light';
    artboard.setPointerCapture(event.pointerId);
    if (pointerMode === 'split') setSplitFromEvent(event);
    else if (pointerMode === 'depth') { lastPaintPoint = null; moveBrushCursor(event); paintDepth(event); }
    else { selectNearbyLight(event, artboard, 32); setLightFromEvent(event, artboard); }
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
  miniMap.addEventListener('pointerdown', event => { movingMiniMap = true; miniMap.setPointerCapture(event.pointerId); selectNearbyLight(event, miniMap, 13); setLightFromEvent(event, miniMap); });
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
    saveSelectedLight();
    updateControlUI();
    render();
  });

  $('compareButton').addEventListener('click', () => { if (state.depthEditing || state.depthPreview || state.normalPreview || state.materialPreview) return; state.compare = !state.compare; state.before = false; updateControlUI(); render(); });
  const beforeButton = $('beforeButton');
  const showBefore = () => { if (state.depthEditing || state.depthPreview || state.normalPreview || state.materialPreview) return; state.before = true; updateControlUI(); render(); };
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
    const previousMaterialPreview = state.materialPreview;
    state.compare = false;
    state.before = false;
    state.depthEditing = false;
    state.depthPreview = false;
    state.normalPreview = false;
    state.materialPreview = false;
    render();
    canvas.toBlob(blob => {
      state.compare = previousCompare;
      state.before = previousBefore;
      state.depthEditing = previousDepthEditing;
      state.depthPreview = previousDepthPreview;
      state.normalPreview = previousNormalPreview;
      state.materialPreview = previousMaterialPreview;
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
  loadNormalWasm();
  const sample = new Image();
  sample.onload = () => setImage(sample, 'サンプルイラスト');
  sample.onerror = () => showToast('サンプルイラストを読み込めませんでした');
  sample.src = './assets/demo-illustration.svg';
})();
