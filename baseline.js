// ── Engine State ──────────────────────────────────────────────────────────────
let   logBox                 = null;
let   webStream              = null;
let   alignHardwareLayersRef = null;
let   vidtex                 = null;
let   isWebGL2Supported      = false;
let   gl                     = null;
const posAttributeLocation   = 0;
let   textureLocation        = null;
let   stagingCanvas          = null;
let   stagingCtx             = null;
let   useCanvasFallback      = false;
let   cameraElement          = null; 
let   rafHandle              = null;
let   isProbeArmed           = true;
let   isSafariWebKit         = false;
let   activeRenderPath       = 1;      // 1 = webgl, 2 = webgpu
let   gpuDevice              = null;
let   gpuContext             = null;
let   gpuPipeline            = null;
let   gpuSampler             = null;
let   gpuBindGroupLayout     = null;
const GPU_CLEAR_VALUE        = { r: 0, g: 0, b: 0, a: 1 };
let   currentWidth           = window.innerWidth;
let   currentHeight          = window.innerHeight;
let   logs                   = '-- logs --------------------';
let   wVideo                 = 0;
let   hVideo                 = 0;
let   wScreen                = 0;
let   hScreen                = 0;
let   targetWidth            = 0;
let   targetHeight           = 0;
let   hardwareHz             = 60;   
let   frameStepSize          = 1.0;  
let   frameAccumulator       = 0.0;  
let   hardwareInfoCached     = false;
let   gpuPipelineFallback    = null;   
let   gpuBindGroupLayoutFallback = null;
let   gpuFallbackTexture     = null;    
let   useExternalTexture     = true;    
let   lastFrameTime          = -1;
let   recalibrationRuns      = 0;
let   lastCandidateHz        = 0;      // for two‑consecutive agreement
let   pendingUpgradeHz       = 0;
let   useRVFC                = false;  // default OFF – rAF is used
let   loopType               = 'raf'; 
const RECALIBRATION_MAX        = 6;
const RECALIBRATION_DELAY      = 2000;   // 2 s between re‑checks
const MIN_OCCURRENCES_INITIAL  = 5;
const MIN_OCCURRENCES_RECHECK  = 3;
const PHYSICAL_FLOOR_MS        = 3.0;
const hasRVFC = typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function';
const isFirefox = navigator.userAgent.toLowerCase().includes('firefox');
const requiresGesture = navigator.vendor === 'Apple Computer, Inc.' || /(iPhone|iPad|iPod)/.test(navigator.userAgent);

// calibration state (runs in parallel, zero overhead in render loop)
let   calibrationDone        = false;
let   calibrationPromise     = null;

// rAF availability flag
const hasRAF = typeof requestAnimationFrame !== 'undefined';

function staticDummyExecutor() { /* Safe No-Op */ }
let updateTextureExecutorFast   = staticDummyExecutor;
let updateTextureExecutorLegacy = staticDummyExecutor;

// ── SHADERS ───────────────────────────────────────────────────────────────────
const VS_SOURCE = `#version 100
    attribute vec2 a_position;
    varying   vec2 v_texCoord;
    void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord  = a_position * vec2(0.5, -0.5) + 0.5;
    }`;

const FS_SOURCE = `#version 100
    precision mediump float;
    varying   vec2 v_texCoord;
    uniform sampler2D u_cameraTexture;
    void main() {
        gl_FragColor = texture2D(u_cameraTexture, v_texCoord);
    }`;

const WGSL_SOURCE = `
struct VertexOut {
    @builtin(position) pos: vec4<f32>,
    @location(0)       uv:  vec2<f32>,
}
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VertexOut {
    let pos = array<vec2<f32>,4>(
        vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0),
        vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0,  1.0));
    let uv  = array<vec2<f32>,4>(
        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0),
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0));
    return VertexOut(vec4<f32>(pos[vi], 0.0, 1.0), uv[vi]);
}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var vid:  texture_external;
@fragment fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    return textureSampleBaseClampToEdge(vid, samp, uv);
}`;

const WGSL_SOURCE_FALLBACK = `
struct VertexOut {
    @builtin(position) pos: vec4<f32>,
    @location(0)       uv:  vec2<f32>,
}
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VertexOut {
    let pos = array<vec2<f32>,4>(
        vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0),
        vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0,  1.0));
    let uv  = array<vec2<f32>,4>(
        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0),
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0));
    return VertexOut(vec4<f32>(pos[vi], 0.0, 1.0), uv[vi]);
}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var vid:  texture_2d<f32>;
@fragment fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    return textureSample(vid, samp, uv);
}`;

let shaderProgram  = null;
let positionBuffer = null;
let canvas         = null;


// ── VERSION LOG ──────────────────────────────────────────────────────────────────
logit("WebAR engine version: 0.0.38")

// ── LIVE LOGS ──────────────────────────────────────────────────────────────────
function logit(text, mode = 1){
    if (mode === 1) {
        logs += '<br>' + text;
        console.log(text);
    } else if (mode === 2) {
        logs += `<br> <span id="warn">${text}</span>`;
        console.warn(text);
    } else if (mode === 3) {
        logs += `<br> <span id="error">${text}</span>`;
        console.error(text);
    }
    if (logBox) logBox.innerHTML = logs;
}

// ── HARDWARE INFO (cached once) ────────────────────────────────────────────────
hardwareInfoCached = false;
function hardwareInfo(){
    if (!hardwareInfoCached) {
        isSafariWebKit = (navigator.vendor === 'Apple Computer, Inc.') &&
                         /CriOS|FxiOS|OPiOS|EdgA/i.test(navigator.userAgent) === false;
        if (isSafariWebKit) logit("Safari/WebKit detected — IOSurface path will be used.");

        let gpuName = "Unknown GPU";
        if (gl) {
            const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
            gpuName = debugInfo
                ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
                : gl.getParameter(gl.RENDERER);
        } else if (gpuDevice) {
            gpuName = "WebGPU Native Pipeline";
        }
        logit(`📱 GPU: ${gpuName}`);

        const gpuUpper = gpuName.toUpperCase();
        const isLegacySilicon = /MALI-(2\d\d|3\d\d|4[05]\d|47\d)/.test(gpuUpper) ||
                                /ADRENO \(TM\) [234]\d\d/.test(gpuUpper) ||
                                gpuUpper.includes('SGX') ||
                                /TEGRA [234]\b/.test(gpuUpper) ||
                                gpuUpper.includes('VIVANTE') || /\bGC\d{3,4}\b/.test(gpuUpper);
        if (isLegacySilicon) logit("⚠️ Legacy silicon — stride/NPOT guardrails active.", 2);
        if (isFirefox) logit("🦊 Firefox detected – Chrome recommended for best performance.", 2);
        hardwareInfoCached = true;
    }
    // Layout‑dependent log still updates
    logit(`<br><b>System Hardware Info:</b><hr>
           <b>Active Native Stream Pipeline:</b><br/>
           ├─ <b>HTML Video Element Res:</b> <span> ${wVideo}x${hVideo} px </span><br/>
           └─ <b>Hardware Track Config:</b> <span> ${wScreen}x${hScreen} px </span><br/>`);
}

// ── REFRESH RATE CALIBRATION ──────────────────────────
function calibrateRefreshRate() {
    return new Promise((resolve) => {
        if (!hasRAF) {
            hardwareHz = 60;  frameStepSize = 1.0;
            calibrationDone = true;
            logit("🖥️ No rAF – default 60 Hz.");
            resolve();
            return;
        }

        let frames = 0, lastTime = 0;
        const buckets = {};
        const MAX_FRAMES = 180;               // ~3 s on 60 Hz, enough data

        function sample(ts) {
            if (lastTime) {
                const interval = ts - lastTime;
                const bucket = Math.round(interval * 2) / 2;   // 0.5 ms precision
                buckets[bucket] = (buckets[bucket] || 0) + 1;
                frames++;
            }
            lastTime = ts;
            if (frames < MAX_FRAMES) {
                requestAnimationFrame(sample);
            } else {
                const hz = extractRefreshRate(buckets, MIN_OCCURRENCES_INITIAL, true);
                hardwareHz = hz;
                frameStepSize = 60 / hz;
                calibrationDone = true;
                resolve();
                startRecalibration();          // background correction
            }
        }
        requestAnimationFrame(sample);
    });
}

function startRecalibration() {
    if (recalibrationRuns >= RECALIBRATION_MAX) return;
    setTimeout(() => {
        quickRecalibration();
        recalibrationRuns++;
        startRecalibration();
    }, RECALIBRATION_DELAY);
}

function quickRecalibration() {
    if (!hasRAF) return;

    let frames = 0, lastTime = 0;
    const buckets = {};
    const MAX_FRAMES = 60;                   // ~1 s

    function sample(ts) {
        if (lastTime) {
            const interval = ts - lastTime;
            const bucket = Math.round(interval * 2) / 2;
            buckets[bucket] = (buckets[bucket] || 0) + 1;
            frames++;
        }
        lastTime = ts;
        if (frames < MAX_FRAMES) {
            requestAnimationFrame(sample);
        } else {
            const candidateHz = extractRefreshRate(buckets, MIN_OCCURRENCES_RECHECK, false);
            logit(`   ↳ Recalibration #${recalibrationRuns+1}: candidate ${candidateHz} Hz`);

            // Two‑consecutive‑agreement rule to upgrade
            if (candidateHz > hardwareHz) {
                if (candidateHz === lastCandidateHz) {
                    // second consecutive match → upgrade
                    hardwareHz = candidateHz;
                    frameStepSize = 60 / hardwareHz;
                    logit(`🔄 Upgraded refresh rate to ${hardwareHz} Hz (2‑recheck consensus).`);
                    lastCandidateHz = 0;          // reset
                } else {
                    // first time seeing this higher rate, remember it
                    lastCandidateHz = candidateHz;
                }
            } else {
                lastCandidateHz = 0;              // reset if not higher
            }
        }
    }
    requestAnimationFrame(sample);
}

// Extracts the most reliable refresh rate from a bucket histogram.
// If logDetails is true, prints the dominant interval and candidate rate.
function extractRefreshRate(buckets, minOccurrences, logDetails) {
    let bestInterval = Infinity;
    let bestCount = 0;

    for (const [val, count] of Object.entries(buckets)) {
        const interval = parseFloat(val);
        if (interval < PHYSICAL_FLOOR_MS) continue;          // discard impossible intervals
        if (count > bestCount || (count === bestCount && interval < bestInterval)) {
            bestCount = count;
            bestInterval = interval;
        }
    }

    // If no reliable interval found, fallback to 60 Hz
    if (bestInterval === Infinity || bestCount < minOccurrences) {
        if (logDetails) logit(`⚠️ No dominant interval – falling back to 60 Hz`);
        return 60;
    }

    const hz = mapIntervalToHz(bestInterval);
    if (logDetails) logit(`🖥️ Initial calibration: mode ${bestInterval} ms → ${hz} Hz (count ${bestCount})`);
    return hz;
}

function mapIntervalToHz(ms) {
    if      (ms <= 4.5)  return 240;
    else if (ms <= 6.5)  return 165;
    else if (ms <= 7.5)  return 144;
    else if (ms <= 8.8)  return 120;
    else if (ms <= 11.5) return 90;
    else if (ms <= 14.0) return 75;
    else if (ms <= 17.5) return 60;
    else if (ms <= 35.0) return 30;
    else if (ms <= 43.5) return 24;
    else if (ms <= 102.0) return 10;
    else                 return 1;
}

function scheduleRecalibration() {
    if (recalibrationCount >= RECALIBRATION_MAX) return;
    setTimeout(() => {
        runQuickRecalibration();
        recalibrationCount++;
        scheduleRecalibration();
    }, RECALIBRATION_INTERVAL);
}

function runQuickRecalibration() {
    if (!hasRAF) return;
    let frames = 0, lastTime = 0;
    const buckets = {};
    const MAX_FRAMES = 30;
    const MIN_OCCURRENCES = 3;  // more lenient for short sample

    function sample(ts) {
        if (lastTime) {
            const interval = ts - lastTime;
            const bucket = Math.round(interval * 2) / 2;
            buckets[bucket] = (buckets[bucket] || 0) + 1;
            frames++;
        }
        lastTime = ts;
        if (frames < MAX_FRAMES) {
            requestAnimationFrame(sample);
        } else {
            let bestInterval = Infinity;
            for (const [val, count] of Object.entries(buckets)) {
                const interval = parseFloat(val);
                if (count >= MIN_OCCURRENCES && interval < bestInterval) {
                    bestInterval = interval;
                }
            }
            const newHz = mapIntervalToHz(bestInterval);
            if (newHz > hardwareHz) {
                hardwareHz = newHz;
                frameStepSize = 60 / hardwareHz;
                logit(`🔄 Background recalibration: updated to ${hardwareHz}Hz`);
            }
        }
    }
    requestAnimationFrame(sample);
}

// ── WEBGL INIT ─────────────────────────────────────────────────────────────────
function init() {
    canvas = document.querySelector("#gl_overlay");
    const ctxOptions = {
        alpha: false, antialias: false, premultipliedAlpha: false,
        preserveDrawingBuffer: false, powerPreference: 'low-power',
    };
    const gl2Context = canvas.getContext("webgl2", ctxOptions);
    if (gl2Context) {
        gl = gl2Context;
        isWebGL2Supported = true;
        logit("WebGL 2 supported!");
    } else {
        gl = canvas.getContext("webgl", ctxOptions);
        logit("WebGL 1 fallback.");
    }
    if (!gl) { logit("❌ CRITICAL: WebGL context creation failed.", 3); return; }

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    shaderProgram = createWebGLProgram(VS_SOURCE, FS_SOURCE);
    if (!shaderProgram) { logit("❌ Shader setup failed.", 3); return; }

    const vertices = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
    positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    textureLocation = gl.getUniformLocation(shaderProgram, "u_cameraTexture");
    gl.enableVertexAttribArray(posAttributeLocation);
    gl.useProgram(shaderProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(posAttributeLocation, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(textureLocation, 0);
    logit("✅ Initialization & shader compilation done!");
}

// ── WEBGPU PIPELINE ────────────────────────────────────────────────────────────
async function detectWebGPU() {
    if (typeof navigator.gpu === 'undefined' || !navigator.gpu) return null;
    try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
        if (!adapter) return null;
        return adapter.requestDevice();
    } catch(e) {
        logit('[WebGPU] Detection failed: ' + e, 2);
        return null;
    }
}

function initWebGPU() {
    canvas = document.querySelector('#gl_overlay');
    gpuContext = canvas.getContext('webgpu');
    if (!gpuContext) {
        logit('❌ [WebGPU] GPUCanvasContext unavailable.', 3);
        return false;
    }
    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    gpuContext.configure({ device: gpuDevice, format: canvasFormat, alphaMode: 'opaque' });

    useExternalTexture = (typeof gpuDevice.importExternalTexture === 'function');
    gpuSampler = gpuDevice.createSampler({
        magFilter: 'linear', minFilter: 'linear',
        addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    });

    if (useExternalTexture) {
        const shaderModule = gpuDevice.createShaderModule({ code: WGSL_SOURCE });
        gpuPipeline = gpuDevice.createRenderPipeline({
            layout: 'auto',
            vertex:   { module: shaderModule, entryPoint: 'vs' },
            fragment: { module: shaderModule, entryPoint: 'fs', targets: [{ format: canvasFormat }] },
            primitive: { topology: 'triangle-strip', stripIndexFormat: 'uint32' },
        });
        gpuBindGroupLayout = gpuPipeline.getBindGroupLayout(0);
        logit('✅ [WebGPU] Zero‑copy pipeline ready.');
    } else {
        const fallbackShader = gpuDevice.createShaderModule({ code: WGSL_SOURCE_FALLBACK });
        gpuPipelineFallback = gpuDevice.createRenderPipeline({
            layout: 'auto',
            vertex:   { module: fallbackShader, entryPoint: 'vs' },
            fragment: { module: fallbackShader, entryPoint: 'fs', targets: [{ format: canvasFormat }] },
            primitive: { topology: 'triangle-strip', stripIndexFormat: 'uint32' },
        });
        gpuBindGroupLayoutFallback = gpuPipelineFallback.getBindGroupLayout(0);
        logit('⚠️ [WebGPU] Fallback pipeline ready (copyExternalImageToTexture).');
    }
    return true;
}

// ── WebGPU render functions (branch‑free per path) ────────────────────────────
function renderWebGPU_ZeroCopy_Fast(videoElement) {
    const externalTexture = gpuDevice.importExternalTexture({ source: videoElement });
    const bindGroup = gpuDevice.createBindGroup({
        layout: gpuBindGroupLayout,
        entries: [
            { binding: 0, resource: gpuSampler },
            { binding: 1, resource: externalTexture },
        ],
    });
    const cmd  = gpuDevice.createCommandEncoder();
    const pass = cmd.beginRenderPass({
        colorAttachments: [{
            view:       gpuContext.getCurrentTexture().createView(),
            clearValue: GPU_CLEAR_VALUE,
            loadOp:     'clear',
            storeOp:    'store',
        }],
    });
    pass.setPipeline(gpuPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(4);
    pass.end();
    gpuDevice.queue.submit([cmd.finish()]);
}

function renderWebGPU_Fallback_Fast(videoElement) {
    // gpuFallbackTexture already correct size (managed in layout)
    gpuDevice.queue.copyExternalImageToTexture(
        { source: videoElement },
        { texture: gpuFallbackTexture },
        { width: videoElement.videoWidth, height: videoElement.videoHeight }
    );
    const bindGroup = gpuDevice.createBindGroup({
        layout: gpuBindGroupLayoutFallback,
        entries: [
            { binding: 0, resource: gpuSampler },
            { binding: 1, resource: gpuFallbackTexture.createView() },
        ],
    });
    const cmd  = gpuDevice.createCommandEncoder();
    const pass = cmd.beginRenderPass({
        colorAttachments: [{
            view:       gpuContext.getCurrentTexture().createView(),
            clearValue: GPU_CLEAR_VALUE,
            loadOp:     'clear',
            storeOp:    'store',
        }],
    });
    pass.setPipeline(gpuPipelineFallback);
    pass.setBindGroup(0, bindGroup);
    pass.draw(4);
    pass.end();
    gpuDevice.queue.submit([cmd.finish()]);
}

function restoreHoistedState() {
    gl.useProgram(shaderProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(posAttributeLocation, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, vidtex);
    gl.uniform1i(textureLocation, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

// ── VRAM ALLOCATION ───────────────────────────────────────────────────────────
function allocateVRAMTexture(width, height) {
    if (vidtex) { gl.deleteTexture(vidtex); }
    vidtex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, vidtex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
}

// ── CAMERA SETUP ──────────────────────────────────────────────────────────────
function settingCamera() {
    // Legacy polyfill
    if (!navigator.mediaDevices) navigator.mediaDevices = {};
    if (!navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia = function(constraints) {
            const fn = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
            if (!fn) return Promise.reject(new Error('UserMedia API missing'));
            return new Promise((resolve, reject) => { fn.call(navigator, constraints, resolve, reject); });
        };
    }

    const container  = document.getElementById('curvix-container');
    const vid        = document.getElementById('vid');
    const gl_overlay = document.getElementById('gl_overlay');
    const b_cam      = document.getElementById('b_cam_input');
    const playOverlay = document.getElementById('play-overlay');
    const gesturePlayBtn = document.getElementById('gesture-play-btn');

    if (!container || !vid || !gl_overlay || !b_cam) {
        logit("❌ CRITICAL: DOM node link failure.", 3);
        return;
    }

    // ── Gesture overlay logic ─────────────────────────────────────────────
    function showPlayButton() {
        if (requiresGesture && playOverlay && gesturePlayBtn) {
            playOverlay.style.display = 'flex';
            vid.style.opacity = '0';
            gl_overlay.style.opacity = '0';
        }
    }

    if (requiresGesture && gesturePlayBtn) {
        gesturePlayBtn.addEventListener('click', () => {
            playOverlay.style.display = 'none';
            b_cam.checked = true;
            startCameraPipeline();
        });
    }

    // ── Layout + VRAM sync ────────────────────────────────────────────────
    alignHardwareLayersRef = function() {
        wVideo = vid.videoWidth;
        hVideo = vid.videoHeight;
        if (wVideo === 0 || hVideo === 0) return;

        const bounds = container.getBoundingClientRect();
        wScreen = bounds.width;
        hScreen = bounds.height;
        if (wScreen === 0 || hScreen === 0) return;

        const targetScale = Math.max(wScreen / wVideo, hScreen / hVideo);
        targetWidth  = Math.round(wVideo * targetScale);
        targetHeight = Math.round(hVideo * targetScale);

        vid.style.width  = targetWidth  + "px";
        vid.style.height = targetHeight + "px";
        gl_overlay.width  = wVideo;
        gl_overlay.height = hVideo;
        gl_overlay.style.width  = targetWidth  + "px";
        gl_overlay.style.height = targetHeight + "px";

        if (gl) gl.viewport(0, 0, wVideo, hVideo);

        // Staging canvas (WebGL only)
        const needsVRAMInit = !stagingCanvas
            || stagingCanvas.width  !== wVideo
            || stagingCanvas.height !== hVideo;
        if (needsVRAMInit && activeRenderPath === 1) {
            if (!stagingCanvas) {
                stagingCanvas = document.createElement('canvas');
                stagingCtx = stagingCanvas.getContext('2d', { willReadFrequently: false });
            }
            stagingCanvas.width  = wVideo;
            stagingCanvas.height = hVideo;
            if (gl) allocateVRAMTexture(wVideo, hVideo);
        }

        // WebGPU fallback texture maintenance (outside render loop)
        if (activeRenderPath === 2 && !useExternalTexture) {
            if (!gpuFallbackTexture ||
                gpuFallbackTexture.width !== wVideo ||
                gpuFallbackTexture.height !== hVideo) {
                if (gpuFallbackTexture) gpuFallbackTexture.destroy();
                gpuFallbackTexture = gpuDevice.createTexture({
                    size: [wVideo, hVideo],
                    format: 'rgba8unorm',
                    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
                });
            }
        }

        hardwareInfo();

        // Assign correct render executor pair
        if (activeRenderPath === 2) {
            gpuContext.configure({
                device:    gpuDevice,
                format:    navigator.gpu.getPreferredCanvasFormat(),
                alphaMode: 'opaque',
            });
            if (useExternalTexture) {
                updateTextureExecutorFast = renderWebGPU_ZeroCopy_Fast;
                updateTextureExecutorLegacy = renderWebGPU_ZeroCopy_Fast;
            } else {
                updateTextureExecutorFast = renderWebGPU_Fallback_Fast;
                updateTextureExecutorLegacy = renderWebGPU_Fallback_Fast;
            }
            logit("🚀 [WebGPU] Canvas resized — executors assigned.");
            return;
        }

        // WebGL paths
        if (isSafariWebKit && isWebGL2Supported) {
            updateTextureExecutorFast = updateVideoTextureIOSurfaceWebGL2;
            updateTextureExecutorLegacy = updateVideoTextureIOSurfaceWebGL2;
            useCanvasFallback = false;
            restoreHoistedState();
            logit("🍎 [Safari] IOSurface (WebGL2) executor armed.");
        } else if (isSafariWebKit && !isWebGL2Supported) {
            updateTextureExecutorFast = updateVideoTextureIOSurfaceWebGL1;
            updateTextureExecutorLegacy = updateVideoTextureIOSurfaceWebGL1;
            useCanvasFallback = false;
            restoreHoistedState();
            logit("🍎 [Safari] IOSurface (WebGL1) executor armed.");
        } else if (isProbeArmed) {
            updateTextureExecutorFast   = probeExecutor;
            updateTextureExecutorLegacy = probeExecutor;
            logit("⏳ [PROBE] Probe armed – awaiting first frame...");
        } else {
            if (useCanvasFallback) {
                updateTextureExecutorFast   = updateVideoTextureCanvasFallback;
                updateTextureExecutorLegacy = updateVideoTextureCanvasFallbackLegacy;  
            } else {
                updateTextureExecutorFast   = updateVideoTextureDirectFast;
                updateTextureExecutorLegacy = updateVideoTextureDirectLegacy;          
            }
            restoreHoistedState();
            logit("🚀 Dual‑path pipeline synchronized.");
        }
    };

    let isCameraStarting = false;
    function startCameraPipeline() {
        if (isCameraStarting) return;
        isCameraStarting = true;

        // Determine screen orientation
        const isPortrait = window.innerHeight > window.innerWidth;
        const constraints = {
            audio: false,
            video: { 
                facingMode: "environment",
                advanced: (() => {
                    const arr = [];
                    if (isPortrait) {
                        // Portrait first
                        arr.push({ width: 1080, height: 1920, frameRate: 60 });
                        arr.push({ width: 720,  height: 1280, frameRate: 60 });
                        arr.push({ width: 1080, height: 1920 });
                        arr.push({ width: 720,  height: 1280 });
                    } else {
                        // Landscape first
                        arr.push({ width: 1920, height: 1080, frameRate: 60 });
                        arr.push({ width: 1280, height: 720,  frameRate: 60 });
                        arr.push({ width: 1920, height: 1080 });
                        arr.push({ width: 1280, height: 720 });
                    }
                    return arr;
                })()
            }
        };

        navigator.mediaDevices.getUserMedia(constraints)
            .then(function(stream) {
                isCameraStarting = false;
                if (b_cam.checked) {
                    logit("⚠️ Camera opened but user requested stop in‑between. Destroying orphaned stream.");
                    stream.getTracks().forEach(t => t.stop());
                    return;
                }
                webStream = stream;
                vid.srcObject = stream;

                vid.addEventListener('loadeddata', async function startLoopOnReady() {
                    if (alignHardwareLayersRef) alignHardwareLayersRef();

                    if (!rafHandle) {
                        // rAF is the default; rVFC only if explicitly enabled
                        if (useRVFC && vid.requestVideoFrameCallback) {
                            rafHandle = vid.requestVideoFrameCallback(renderLoopRVFC);
                            loopType = 'rvfc';
                            logit("🎯 rVFC Loop (manually enabled).");
                        } else if (hasRAF) {
                            rafHandle = requestAnimationFrame(renderLoopRAF);
                            loopType = 'raf';
                            logit("🔄 rAF Loop (default).");
                        } else {
                            rafHandle = setTimeout(renderLoopTimeout, 16);
                            loopType = 'timeout';
                            logit("⏱️ Fallback to setTimeout loop (legacy device).");
                        }
                    }
                    vid.removeEventListener('loadeddata', startLoopOnReady);
                });

                vid.play().then(() => {
                    logit("🚀 Camera hardware linked successfully.");
                    vid.style.opacity = '1';
                    gl_overlay.style.opacity = '1';
                }).catch(err => {
                    logit("❌ Video play() rejected: " + err.name, 3);
                    stopCameraPipeline();
                    if (requiresGesture) showPlayButton();
                });
            })
            .catch(function(err) {
                isCameraStarting = false;
                console.error("❌ CRITICAL: Hardware rejected pipeline.", err);
                logit("❌ CRITICAL: Hardware rejected pipeline." + err);
                alert("Hardware Stream Failure: " + err.name);
            });
    }

    function stopCameraPipeline() {
        if (webStream) {
            webStream.getTracks().forEach(t => t.stop());
            vid.removeEventListener('playing', alignHardwareLayersRef);
            vid.srcObject = null;
            webStream = null;
            vid.load();
            if (gl) gl.bindTexture(gl.TEXTURE_2D, null);
            updateTextureExecutorFast   = staticDummyExecutor;
            updateTextureExecutorLegacy = staticDummyExecutor;
            lastFrameTime = -1;
            if (rafHandle) {
                if (loopType === 'rvfc') {
                    vid.cancelVideoFrameCallback(rafHandle);
                } else if (loopType === 'raf') {
                    cancelAnimationFrame(rafHandle);
                } else { // 'timeout'
                    clearTimeout(rafHandle);
                }
                rafHandle = null;
                loopType = 'raf';  // reset to default
            }
            if (requiresGesture && !b_cam.checked) showPlayButton();
            logit("🛑 Pipeline stopped. Memory references unlinked.");
        }
    }

    b_cam.addEventListener('change', () => {
        if (b_cam.checked) stopCameraPipeline();
        else { logit("⏳ Re-initializing Camera Engine..."); startCameraPipeline(); }
    });

    // Start
    if (requiresGesture) {
        showPlayButton();
    } else {
        startCameraPipeline();
    }
}

// ── TEXTURE UPDATE FUNCTIONS ──────────────────────────────────────────────────
function updateVideoTextureDirectFast(videoElement) {
    gl.bindTexture(gl.TEXTURE_2D, vidtex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function updateVideoTextureDirectLegacy(videoElement) {
    if (videoElement.currentTime === lastFrameTime) return;
    lastFrameTime = videoElement.currentTime;
    gl.bindTexture(gl.TEXTURE_2D, vidtex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);  
}

function updateVideoTextureCanvasFallback(videoElement) {
    stagingCtx.drawImage(videoElement, 0, 0, stagingCanvas.width, stagingCanvas.height);
    gl.bindTexture(gl.TEXTURE_2D, vidtex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, stagingCanvas);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function updateVideoTextureCanvasFallbackLegacy(videoElement) {
    if (videoElement.currentTime === lastFrameTime) return;
    lastFrameTime = videoElement.currentTime;
    stagingCtx.drawImage(videoElement, 0, 0, stagingCanvas.width, stagingCanvas.height);
    gl.bindTexture(gl.TEXTURE_2D, vidtex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, stagingCanvas);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function updateVideoTextureIOSurfaceWebGL1(videoElement) {
    gl.bindTexture(gl.TEXTURE_2D, vidtex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function updateVideoTextureIOSurfaceWebGL2(videoElement) {
    gl.bindTexture(gl.TEXTURE_2D, vidtex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// ── PROBE ─────────────────────────────────────────────────────────────────────
function probeDirectVideoUpload(videoElement) {
    const vw = videoElement.videoWidth;
    const vh = videoElement.videoHeight;

    const probeTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, probeTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
    if (gl.getError() !== gl.NO_ERROR) {
        logit("[PROBE] getError — direct upload broken.", 2);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.deleteTexture(probeTex);
        restoreHoistedState();
        return false;
    }

    const probeFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, probeFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, probeTex, 0);

    let directWorks = false;
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
        const pixel = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        directWorks = (pixel[3] === 255);
        logit(`[PROBE] A:${pixel[3]} → ${directWorks ? "✅ Direct" : "❌ FAIL"}`, directWorks ? 1 : 2);
    } else {
        logit("[PROBE] FBO incomplete → canvas fallback.", 2);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteFramebuffer(probeFBO);
    gl.deleteTexture(probeTex);
    restoreHoistedState();
    return directWorks;
}

function probeExecutor(videoElement) {
    if (videoElement.readyState < 2) return;
    isProbeArmed = false;
    const directWorks = probeDirectVideoUpload(videoElement);

    if (directWorks) {
        updateTextureExecutorFast   = updateVideoTextureDirectFast;
        updateTextureExecutorLegacy = updateVideoTextureDirectLegacy;
        logit("🚀 [PROBE] PASS — Zero‑copy fast‑path unlocked.");
        useCanvasFallback = false;
    } else {
        updateTextureExecutorFast   = updateVideoTextureCanvasFallback;
        updateTextureExecutorLegacy = updateVideoTextureCanvasFallbackLegacy;
        logit("⚠️ [PROBE] FAIL — Falling back to CPU buffers.", 2);
        useCanvasFallback = true;
    }
    updateTextureExecutorFast(videoElement);
}

// ── SHADER COMPILATION ────────────────────────────────────────────────────────
function compileShaderWorker(source, type) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        logit("❌ GLSL Compile Error: " + gl.getShaderInfoLog(shader), 3);
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function createWebGLProgram(vsSource, fsSource) {
    const vShader = compileShaderWorker(vsSource, gl.VERTEX_SHADER);
    const fShader = compileShaderWorker(fsSource, gl.FRAGMENT_SHADER);
    if (!vShader || !fShader) {
        if (vShader) gl.deleteShader(vShader);
        if (fShader) gl.deleteShader(fShader);
        return null;
    }
    const program = gl.createProgram();
    gl.attachShader(program, vShader);
    gl.attachShader(program, fShader);
    gl.bindAttribLocation(program, 0, "a_position");
    gl.linkProgram(program);
    gl.detachShader(program, vShader);
    gl.detachShader(program, fShader);
    gl.deleteShader(vShader);
    gl.deleteShader(fShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        logit("❌ Shader Link Error: " + gl.getProgramInfoLog(program), 3);
        gl.deleteProgram(program);
        return null;
    }
    return program;
}

// ── RENDER LOOPS ──────────────────────────────────────────────────────────────
function renderLoopRVFC(now, metadata) {
    updateTextureExecutorFast(cameraElement);
    rafHandle = cameraElement.requestVideoFrameCallback(renderLoopRVFC);
}

function renderLoopRAF() {
    frameAccumulator += frameStepSize;
    if (frameAccumulator >= 1.0) {
        frameAccumulator = 0.0;
        updateTextureExecutorLegacy(cameraElement);
    }
    rafHandle = requestAnimationFrame(renderLoopRAF);
}

function renderLoopTimeout() {
    frameAccumulator += frameStepSize;
    if (frameAccumulator >= 1.0) {
        frameAccumulator = 0.0;
        updateTextureExecutorLegacy(cameraElement);
    }
    rafHandle = setTimeout(renderLoopTimeout, 16);
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", async function() {
    logBox = document.getElementById('logs');
    cameraElement = document.getElementById('vid');

    // Start calibration immediately (no delay)
    calibrationPromise = calibrateRefreshRate();

    // Detect GPU & init rendering backends (in parallel with calibration)
    const gpuDev = await detectWebGPU();
    if (gpuDev) {
        gpuDevice = gpuDev;
        activeRenderPath = 2;
        if (!initWebGPU()) {
            activeRenderPath = 1;
            logit('⚠️ [WebGPU] Init failed — falling back to WebGL.', 2);
            init();
        }
    } else {
        activeRenderPath = 1;
        init();
    }

    // Start camera immediately; calibration continues in background
    settingCamera();

    window.addEventListener('resize', () => {
        currentWidth = window.innerWidth;
        currentHeight = window.innerHeight;
        if (alignHardwareLayersRef) alignHardwareLayersRef();
    });
});

window.addEventListener("beforeunload", () => {
    if (rafHandle) {
        if (loopType === 'rvfc') {
            cameraElement.cancelVideoFrameCallback(rafHandle);
        } else if (loopType === 'raf') {
            cancelAnimationFrame(rafHandle);
        } else {
            clearTimeout(rafHandle);
        }
        rafHandle = null;
    }
    if (webStream) {
        webStream.getTracks().forEach(t => t.stop());
        webStream = null;
    }
    if (gpuDevice) {
        if (gpuFallbackTexture) gpuFallbackTexture.destroy();
        gpuDevice.destroy();
        gpuDevice = null;
    }
    gl = null;
    canvas = null;
});