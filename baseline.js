// ── GLOBALS ──────────────────────────────────────────────────────────────────
var webStream              = null;
var alignHardwareLayersRef = null;
var vidtex                 = null;
var lastFrameTime          = -1;
var isWebGL2Supported      = false;
var gl                     = null;
var posAttributeLocation   = 0;     
var textureLocation        = null;
var stagingCanvas          = null;
var stagingCtx             = null;
var useCanvasFallback      = false;
var cameraElement          = null; 
var rafHandle              = null;
var isProbeArmed           = true;
var isSafariWebKit         = false;   // Set in init() after GL context
var activeRenderPath       = 1;       // 1 = webgl, 2 = webgpu
var gpuDevice              = null;    // GPUDevice (WebGPU path)
var gpuContext             = null;    // GPUCanvasContext
var gpuPipeline            = null;    // GPURenderPipeline
var gpuSampler             = null;    // GPUSampler (reused every frame)
var gpuBindGroupLayout     = null;    // GPUBindGroupLayout (reused every frame)
var GPU_CLEAR_VALUE        = { r: 0, g: 0, b: 0, a: 1 };
let currentWidth           = window.innerWidth;
let currentHeight          = window.innerHeight;
var logs                   = '-- logs --------------------';
var uResolutionLoc         = null;
var wVideo                 = 0;
var hVideo                 = 0;
var wScreen                = 0;
var hScreen                = 0;
var targetWidth            = 0;
var targetHeight           = 0;
var isFirefox              = navigator.userAgent.toLowerCase().includes('firefox');
let resolutionBuffer;

function staticDummyExecutor(vid) { /* Safe No-Op: runs before camera is ready */ }
var updateTextureExecutor = staticDummyExecutor;

// ── SHADERS ───────────────────────────────────────────────────────────────────
// [VS] Y-flip handled here (free, no pipeline stall) — UNPACK_FLIP_Y_WEBGL stays false
var VS_SOURCE = `
    uniform vec2 u_resolution;
    attribute vec2 a_position;
    varying vec2 v_texCoord;
    void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord  = a_position * vec2(0.5, -0.5) + 0.5;
    }
`;
// [VS] Simplified single-expression:
//   a_position.x: [-1..1] * 0.5 + 0.5 = [0..1]   (normal U)
//   a_position.y: [-1..1] * -0.5 + 0.5 = [1..0]  (Y-flipped V)
// Equivalent to original two-step but no intermediate vec2 allocation.

var FS_SOURCE = `
    precision mediump float;
    varying vec2 v_texCoord;
    uniform sampler2D u_cameraTexture;
    void main() {
        gl_FragColor = texture2D(u_cameraTexture, v_texCoord);
    }
`;

var WGSL_SOURCE = `
    struct VertexOut {
        @builtin(position) pos: vec4<f32>,
        @location(0)       uv:  vec2<f32>,
    }

    // Full-screen quad: 4 vertices, no VBO needed in WebGPU
    @vertex fn vs(@builtin(vertex_index) vi: u32) -> VertexOut {
        var pos = array<vec2<f32>,4>(
            vec2<f32>(-1.0, -1.0),
            vec2<f32>( 1.0, -1.0),
            vec2<f32>(-1.0,  1.0),
            vec2<f32>( 1.0,  1.0)
        );
        // Y-flip in UV (same as WebGL vertex shader logic)
        var uv = array<vec2<f32>,4>(
            vec2<f32>(0.0, 1.0),
            vec2<f32>(1.0, 1.0),
            vec2<f32>(0.0, 0.0),
            vec2<f32>(1.0, 0.0)
        );
        var o: VertexOut;
        o.pos = vec4<f32>(pos[vi], 0.0, 1.0);
        o.uv  = uv[vi];
        return o;
    }

    @group(0) @binding(0) var samp: sampler;
    @group(0) @binding(1) var vid:  texture_external; // Hardware YUV path

    @fragment fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
        // textureSampleBaseClampToEdge: required for texture_external
        // YUV→RGBA handled internally by GPU driver — no manual conversion
        // Greyscale pass (future): add here ONLY for webgl path, NOT here
        return textureSampleBaseClampToEdge(vid, samp, uv);
    }
`;

var shaderProgram  = null;
var positionBuffer = null;
var canvas         = null;

// ── LIVE LOGS ──────────────────────────────────────────────────────────────────
//A logging system for mobile browsers:
var logBox  = null;
function logit(text, mode = 1){
    if (mode === 1){
        //normal mode
        logs = logs + '<br>' +text;
        console.log(text)
    }
    if (mode === 2){
        //warn mode
        logs = logs + '<br> <span id="warn">' + text + '</span>';
        console.warn(text)
    }
    if (mode === 3){
        //error mode
        logs = logs + '<br> <span id="error">' + text + '</span>';
        console.error(text)
    }
    if (logBox) logBox.innerHTML = logs;
}

// ── COMMON HARDWARE INFO COLLECTOR ───────────────────────────────────────────────────
function hardwareInfo(){
    var _ua = navigator.userAgent;
    isSafariWebKit = (navigator.vendor === 'Apple Computer, Inc.')
    && _ua.indexOf('CriOS') === -1   // Chrome iOS
    && _ua.indexOf('FxiOS') === -1   // Firefox iOS
    && _ua.indexOf('OPiOS') === -1   // Opera iOS
    && _ua.indexOf('EdgA')  === -1;  // Edge iOS

    if (isSafariWebKit) {
        logit("Safari/WebKit detected — IOSurface path will be used.");
    }

    // ── GPU detection ─────────────────────────────────────────────────────────
    var gpuName = "Unknown GPU";
    if (gl) {
        var debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        if (debugInfo) {
            gpuName = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        } else {
            gpuName = gl.getParameter(gl.RENDERER); 
        }
    } else if (gpuDevice) {
        gpuName = "WebGPU Native Pipeline";
    }
    
    var gpuUpper = gpuName.toUpperCase();
    logit("📱 GPU: " + gpuName);

    var isLegacySilicon =
        /MALI-(2\d\d|3\d\d|4[05]\d|47\d)/.test(gpuUpper)   ||
        /ADRENO \(TM\) [234]\d\d/.test(gpuUpper)           ||
        gpuUpper.includes('SGX')                           ||
        /TEGRA [234]\b/.test(gpuUpper)                     ||
        gpuUpper.includes('VIVANTE') || /\bGC\d{3,4}\b/.test(gpuUpper);

    if (isLegacySilicon) {
        logit("⚠️ Legacy silicon — stride/NPOT guardrails active.", 2);
    }

    // ── LOGGING SCREEN INFO ─────────────────────────────────────────────────────────
    logit(`
            <br>
            <b>System Hardware Info:</b>
            <hr>
            <b>Active Native Stream Pipeline:</b><br/>
            ├─ <b>HTML Video Element Res:</b> <span> ${wVideo}x${hVideo} px </span><br/>
            └─ <b>Hardware Track Config:</b> <span> ${wScreen}x${hScreen} px </span><br/>`);
}

// ── INIT ──────────────────────────────────────────────────────────────────────
function init() {
    canvas = document.querySelector("#gl_overlay");

    var ctxOptions = {
        alpha:                 false, // No alpha compositing pass every frame
        antialias:             false, // Camera feed doesn't need AA
        premultipliedAlpha:    false, // Skip CPU-side alpha multiply pass
        preserveDrawingBuffer: false, // Default false; explicit for clarity
        powerPreference:       'low-power', // Mobile battery optimization
    };

    var gl2Context = canvas.getContext("webgl2", ctxOptions);
    if (gl2Context) {
        gl = gl2Context;
        isWebGL2Supported = true;
        logit("WebGL 2 supported!");
    } else {
        gl = canvas.getContext("webgl", ctxOptions);
        logit("WebGL 1 fallback.");
    }

    if (!gl) {
        logit("❌ CRITICAL: WebGL context creation failed.", 3);
        return;
    }

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);                         // Mali-4xx stride crash fix
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE); // No color-matrix overhead
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);       // No alpha channel waste
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);                  // [B4] Adreno 3xx NPOT freeze fix — global lock

    // ── Shader compilation ────────────────────────────────────────────────────
    shaderProgram = createWebGLProgram(VS_SOURCE, FS_SOURCE);
    if (!shaderProgram) {
        logit("❌ Shader setup failed.", 3);
        return;
    }

    // ── Geometry (full-screen quad, static — never changes) ───────────────────
    var vertices = new Float32Array([
        -1.0, -1.0,   // Bottom-Left
         1.0, -1.0,   // Bottom-Right
        -1.0,  1.0,   // Top-Left
         1.0,  1.0    // Top-Right
    ]);
    positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    // ── Attribute + uniform locations ─────────────────────────────────────────
    // createWebGLProgram calls bindAttribLocation(program, 0, "a_position") before link,
    // which guarantees the location is 0. getAttribLocation query is redundant.
    posAttributeLocation = 0;
    textureLocation      = gl.getUniformLocation(shaderProgram, "u_cameraTexture");
    gl.enableVertexAttribArray(posAttributeLocation);

    // ── Hoisted permanent state bindings ──────────────────────────────────────
    // Set ONCE here. Never changes in this single-pipeline app.
    // Eliminates repeated driver state switches in the render loop.
    gl.useProgram(shaderProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(posAttributeLocation, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(textureLocation, 0);

    logit("✅ Initialization & shader compilation done!");
}

// ── WEBGPU PIPELINE ───────────────────────────────────────────────────────────
async function detectWebGPU() {
    // typeof guard: old browsers se completely safe
    if (typeof navigator.gpu === 'undefined' || !navigator.gpu) return null;
    try {
        var adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
        if (!adapter) return null; // Hardware support nahi
        var device = await adapter.requestDevice();
        if (!device) return null;
        return device;
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

    var canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    gpuContext.configure({
        device:    gpuDevice,
        format:    canvasFormat,
        alphaMode: 'opaque', // No compositor alpha pass
    });

    // Sampler: pre-created ONCE — reused every frame (unlike bindGroup)
    gpuSampler = gpuDevice.createSampler({
        magFilter:    'linear',
        minFilter:    'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
    });

    //resolution buffer:
    resolutionBuffer = gpuDevice.createBuffer({
        size: 8, // vec2f = 8 bytes
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    var shaderModule = gpuDevice.createShaderModule({ code: WGSL_SOURCE });

    gpuPipeline = gpuDevice.createRenderPipeline({
        layout:   'auto',
        vertex:   { module: shaderModule, entryPoint: 'vs' },
        fragment: {
            module:     shaderModule,
            entryPoint: 'fs',
            targets:    [{ format: canvasFormat }],
        },
        primitive: {
            topology:         'triangle-strip', // TRIANGLE_STRIP equivalent
            stripIndexFormat: 'uint32',
        },
    });

    // BindGroupLayout: pre-create ONCE for reuse
    // bindGroup itself must be recreated per frame (externalTexture expires on use)
    gpuBindGroupLayout = gpuPipeline.getBindGroupLayout(0);

    const resData = new Float32Array([currentWidth, currentHeight]);
    gpuDevice.queue.writeBuffer(resolutionBuffer, 0, resData.buffer);

    logit('✅ [WebGPU] Pipeline initialized. Hardware YUV path active.');
    return true;
}

function renderWebGPU(videoElement) {
    if (!videoElement || videoElement.readyState < 2 || videoElement.currentTime === lastFrameTime) return;
    lastFrameTime = videoElement.currentTime;

    // importExternalTexture: hardware YUV zero-copy
    // Expires immediately after being used in bindGroup — recreate every frame (spec-mandated)
    var externalTexture = gpuDevice.importExternalTexture({ source: videoElement });

    // bindGroup: recreated per frame because externalTexture expires
    // gpuSampler + gpuBindGroupLayout: reused (pre-created in initWebGPU)
    var bindGroup = gpuDevice.createBindGroup({
        layout:  gpuBindGroupLayout,
        entries: [
            { binding: 0, resource: gpuSampler         },
            { binding: 1, resource: externalTexture     },
        ],
    });
    
    var cmd  = gpuDevice.createCommandEncoder();
    var pass = cmd.beginRenderPass({
        colorAttachments: [{
            view:       gpuContext.getCurrentTexture().createView(),
            clearValue: GPU_CLEAR_VALUE,
            loadOp:     'clear',
            storeOp:    'store',
        }],
    });
    
    pass.setPipeline(gpuPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(4); // 4 vertices, TRIANGLE_STRIP
    pass.end();

    gpuDevice.queue.submit([cmd.finish()]);
    // externalTexture + bindGroup: ephemeral by design, GC-able immediately
}

function restoreHoistedState() {
    gl.useProgram(shaderProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(posAttributeLocation, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, vidtex); // Real texture rebind
    gl.uniform1i(textureLocation, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); // FBO ko null pe wapas
}

// ── VRAM ALLOCATION ───────────────────────────────────────────────────────────
function allocateVRAMTexture(width, height) {
    if (vidtex) { gl.deleteTexture(vidtex); }

    vidtex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, vidtex);

    // CLAMP_TO_EDGE mandatory for NPOT textures in WebGL 1.0 (camera res is NPOT)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // No generateMipmap: Chromium bug #40412433 — causes SIGABRT on some drivers

    if (isWebGL2Supported && !isSafariWebKit) {
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
        logit("📦 WebGL 2 Immutable VRAM Locked: " + width + "x" + height);
    } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        logit("📦 Mutable VRAM Allocated (Zero-Copy Optimised): " + width + "x" + height);
    }
}

// ── CAMERA SETUP ──────────────────────────────────────────────────────────────
function settingCamera() {
    // Legacy polyfill for Android 4.x / early Android 5.x browsers
    if (!navigator.mediaDevices) { navigator.mediaDevices = {}; }
    if (!navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia = function(constraints) {
            var fn = navigator.getUserMedia
                  || navigator.webkitGetUserMedia
                  || navigator.mozGetUserMedia;
            if (!fn) { return Promise.reject(new Error('UserMedia API missing')); }
            return new Promise(function(resolve, reject) {
                fn.call(navigator, constraints, resolve, reject);
            });
        };
    }

    // Capture DOM nodes ONCE at boot
    var container  = document.getElementById('curvix-container');
    var vid        = document.getElementById('vid');
    var gl_overlay = document.getElementById('gl_overlay');
    var b_cam      = document.getElementById('b_cam_input');

    if (!container || !vid || !gl_overlay || !b_cam) {
        logit("❌ CRITICAL: DOM node link failure.", 3);
        return;
    }

    // ── Layout + VRAM sync ────────────────────────────────────────────────────
    alignHardwareLayersRef = function() {
        wVideo = vid.videoWidth;
        hVideo = vid.videoHeight;
        if (wVideo === 0 || hVideo === 0) return; // Decoder not ready

        var bounds  = container.getBoundingClientRect();
        wScreen = bounds.width;
        hScreen = bounds.height;
        if (wScreen === 0 || hScreen === 0) return; // [MISC] Container not yet laid out

        var targetScale  = Math.max(wScreen / wVideo, hScreen / hVideo);
        targetWidth  = Math.round(wVideo * targetScale);  
        targetHeight = Math.round(hVideo * targetScale); 

        // Old code had this inside the VRAM guard, so orientation changes / window resizes
        // never updated the viewport or CSS when video dimensions hadn't changed.
        vid.style.width          = targetWidth  + "px";
        vid.style.height         = targetHeight + "px";
        gl_overlay.width         = targetWidth;
        gl_overlay.height        = targetHeight;
        gl_overlay.style.width   = targetWidth  + "px";
        gl_overlay.style.height  = targetHeight + "px";
        if (gl) gl.viewport(0, 0, targetWidth, targetHeight);

        // We only re-allocate when the video's native resolution changes, or on first run.
        var needsVRAMInit = !stagingCanvas
                         || stagingCanvas.width  !== wVideo
                         || stagingCanvas.height !== hVideo;

        if (needsVRAMInit) {
            if (!stagingCanvas) {
                stagingCanvas = document.createElement('canvas');
                stagingCtx = stagingCanvas.getContext('2d', { willReadFrequently: false });
            }
            stagingCanvas.width  = wVideo;
            stagingCanvas.height = hVideo;
            if (activeRenderPath === 1 && gl) {
                allocateVRAMTexture(wVideo, hVideo); 
            }
        }

        hardwareInfo();

        if (activeRenderPath === 2 /*webgpu*/) { 
            updateTextureExecutor = renderWebGPU;

            gpuContext.configure({
                device:    gpuDevice,
                format:    navigator.gpu.getPreferredCanvasFormat(),
                alphaMode: 'opaque',
            });

            logit("🚀 [WebGPU] Canvas resized — no VRAM realloc needed.");
            return; 

        } else if (isFirefox) {
            isProbeArmed = false;
            useCanvasFallback = true;
            updateTextureExecutor = updateVideoTextureCanvasFallback;
            restoreHoistedState();
            gl.uniform2f(uResolutionLoc, targetWidth, targetHeight);
            logit("🦊 Firefox Mobile detected — Canvas fallback forced to fix lag.");

        } else if (isSafariWebKit && isWebGL2Supported) {
            // Safari: probe skip — IOSurface always works, direct detection unnecessary
            // Saves one readPixels GPU-CPU sync (one-time but still)
            updateTextureExecutor = updateVideoTextureIOSurfaceWebGL2;
            useCanvasFallback = false;
            restoreHoistedState();
            gl.uniform2f(uResolutionLoc, targetWidth, targetHeight);
            logit("🍎 [Safari] IOSurface (WebGL2) executor armed — probe skipped.");
        
        } else if (isSafariWebKit && !isWebGL2Supported) {
            // Safari: probe skip — IOSurface always works, direct detection unnecessary
            // Saves one readPixels GPU-CPU sync (one-time but still)
            updateTextureExecutor = updateVideoTextureIOSurfaceWebGL1;
            useCanvasFallback = false;
            restoreHoistedState();
            gl.uniform2f(uResolutionLoc, targetWidth, targetHeight);
            logit("🍎 [Safari] IOSurface (WebGL1) executor armed — probe skipped.");

        } else if (isProbeArmed) {
            updateTextureExecutor = probeExecutor;
            gl.useProgram(shaderProgram);
            gl.uniform2f(uResolutionLoc, targetWidth, targetHeight);
            logit("⏳ [PROBE] Probe armed — awaiting first camera frame...");

        } else {
            updateTextureExecutor = useCanvasFallback
                ? updateVideoTextureCanvasFallback
                : updateVideoTextureDirect;
            restoreHoistedState();
            gl.uniform2f(uResolutionLoc, targetWidth, targetHeight);
            logit("🚀 Pipeline restored using previous probe result.");
        }        
    };

    // ── Camera pipeline ───────────────────────────────────────────────────────
    var isCameraStarting = false;
    function startCameraPipeline() {
        if (isCameraStarting) return; 
        isCameraStarting = true;

        var constraints = {
            audio: false,
            video: { 
                facingMode: "environment", 
                advanced: [
                    { width: 1920, height: 1080 }, // 1080p (Landscape orientation)
                    { width: 1080, height: 1920 }, // 1080p (Portrait orientation)
                    { width: 1280, height: 720 },  // 720p (Landscape fallback)
                    { width: 720, height: 1280 }   // 720p (Portrait fallback)
                ]
            }
        };
        navigator.mediaDevices.getUserMedia(constraints)
            .then(function(stream) {
                isCameraStarting = false;
                // Agar OS ne stream de di, par is 500ms ke wait time me user ne button "OFF" kar diya tha
                // Toh is hardware stream ko memory me aane se pehle hi turant destroy kar do!
                if (b_cam.checked) {
                    logit("⚠️ Camera opened but user requested stop in-between. Destroying orphaned stream.");
                    var tracks = stream.getTracks();
                    for (var i = 0; i < tracks.length; i++) { tracks[i].stop(); }
                    return; 
                }

                webStream = stream;
                vid.addEventListener('playing', alignHardwareLayersRef);
                vid.srcObject = stream;
                var playPromise = vid.play()
                if (playPromise !== undefined) {
                    playPromise.catch(function(e) { console.error("Autoplay blocked:", e); logit("Autoplay blocked: " + e ); });
                }
                // On initial load the rAF is already running from DOMContentLoaded.
                if (!rafHandle) {
                    rafHandle = requestAnimationFrame(renderLoop);
                }
                logit("🚀 Camera hardware linked successfully.");
            })
            .catch(function(err) {
                isCameraStarting = false;

                console.error("❌ CRITICAL: Hardware rejected pipeline.", err)
                logit("❌ CRITICAL: Hardware rejected pipeline." + err);
                alert("Hardware Stream Failure: " + err.name);
            });
    }

    function stopCameraPipeline() {
        if (webStream) {
            var tracks = webStream.getTracks();
            for (var i = 0; i < tracks.length; i++) { tracks[i].stop(); }

            vid.removeEventListener('playing', alignHardwareLayersRef);
            vid.srcObject = null;
            webStream     = null;
            vid.load();

            if (gl) { gl.bindTexture(gl.TEXTURE_2D, null); }

            updateTextureExecutor = staticDummyExecutor;
            lastFrameTime         = -1;
            // stagingCanvas         = null; // Forces full re-init on next start
            // stagingCtx            = null;

            if (rafHandle) {
                cancelAnimationFrame(rafHandle);
                rafHandle = null;
            }

            logit("🛑 Pipeline stopped. Memory references unlinked.");
        }
    }

    // Toggle listener set up exactly once
    b_cam.addEventListener('change', function() {
        if (b_cam.checked) {
            stopCameraPipeline(); // Camera off label → stop
        } else {
            logit("⏳ Re-initializing Camera Engine cleanly...");
            startCameraPipeline();
        }
    });

    // ──   SCREEN RESOULTION UPDATOR ──────────────────────────────────────────────────

    startCameraPipeline(); // Fire on load
}

// ── TEXTURE UPDATE FUNCTIONS ──────────────────────────────────────────────────
function updateVideoTextureDirect(videoElement) {
    // currentTime equality guard: prevents redundant uploads when no new frame decoded
    if (videoElement.currentTime === lastFrameTime || videoElement.readyState < 2) return;
    lastFrameTime = videoElement.currentTime;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function updateVideoTextureCanvasFallback(videoElement) {
    if (videoElement.currentTime === lastFrameTime || videoElement.readyState < 2) return;
    lastFrameTime = videoElement.currentTime;
    // Intermediate CPU blit: compositor sees canvas bitmap, not the locked EGLImage/SurfaceTexture
    stagingCtx.drawImage(videoElement, 0, 0, stagingCanvas.width, stagingCanvas.height);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, stagingCanvas);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function updateVideoTextureIOSurfaceWebGL1(videoElement) {
    if (videoElement.currentTime === lastFrameTime || videoElement.readyState < 2) return;
    lastFrameTime = videoElement.currentTime;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
    // gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function updateVideoTextureIOSurfaceWebGL2(videoElement) {
    if (videoElement.currentTime === lastFrameTime || videoElement.readyState < 2) return;
    lastFrameTime = videoElement.currentTime;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// ── VIDEO UPLOAD CAPABILITY PROBE ─────────────────────────────────────────
// Runs ONCE on first valid camera frame. Self-replaces after completion.
// No render loop involvement — pure init-time detection.
function probeDirectVideoUpload(videoElement) {
    var vw = videoElement.videoWidth;   
    var vh = videoElement.videoHeight;

    var probeTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, probeTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, vw, vh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); 

    // Step 3: Direct video upload attempt 
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);

    // Fast-exit: OUT_OF_MEMORY path (confirmed on Pixel 6 Pro — bug #1884282)
    var uploadError = gl.getError();
    if (uploadError !== gl.NO_ERROR) {
        logit("[PROBE] getError → " + uploadError + " — direct upload broken.", 2);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.deleteTexture(probeTex);
        restoreHoistedState();
        return false;
    }

    // FBO attach for GPU readback
    var probeFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, probeFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D, probeTex, 0);

    var directWorks = false;

    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
        var pixel = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

        // alpha=255 → hardware set it (YUV→RGBA always opaque) → upload worked
        // alpha=127 → sentinel untouched → silent failure
        // alpha=0   → browser wrote zeros ("Uploading zeros" path)
        directWorks = (pixel[3] === 255);

        logit("[PROBE] R:" + pixel[0] + " G:" + pixel[1] +
              " B:" + pixel[2] + " A:" + pixel[3] +
              " → " + (directWorks ? "✅ Direct CONFIRMED" : "❌ FAILED (A=" + pixel[3] + ")"),
              directWorks ? 1 : 2);
    } else {
        logit("[PROBE] FBO incomplete → canvas fallback.", 2);
    }

    // Cleanup 
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteFramebuffer(probeFBO);
    gl.deleteTexture(probeTex);

    restoreHoistedState();
    return directWorks;
}

function probeExecutor(videoElement) {
    if (videoElement.readyState < 2) return; // Pehle valid frame ka wait

    isProbeArmed = false; // ✅ SAHI JAGAH: Jab pehla valid frame mila aur execution sure hai

    // Self-replace PEHLE — re-entry impossible (JS single-threaded, but clean)
    updateTextureExecutor = staticDummyExecutor;

    var directWorks   = probeDirectVideoUpload(videoElement);
    useCanvasFallback = !directWorks;

    updateTextureExecutor = directWorks
        ? updateVideoTextureDirect
        : updateVideoTextureCanvasFallback;

    logit(directWorks
        ? "🚀 [PROBE] PASS — Zero-copy direct path locked."
        : "⚠️ [PROBE] FAIL — Canvas fallback locked.", directWorks ? 1 : 2);

    // Current frame miss na ho
    lastFrameTime = -1;
    updateTextureExecutor(videoElement);
}

// ── SHADER COMPILATION ────────────────────────────────────────────────────────
function compileShaderWorker(source, type) {
    var shader = gl.createShader(type);
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
    var vertexShader   = compileShaderWorker(vsSource, gl.VERTEX_SHADER);
    var fragmentShader = compileShaderWorker(fsSource, gl.FRAGMENT_SHADER);

    if (!vertexShader || !fragmentShader) {
        if (vertexShader)   { gl.deleteShader(vertexShader); }
        if (fragmentShader) { gl.deleteShader(fragmentShader); }
        return null;
    }

    var program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);

    // Force attribute 0 = a_position before linking 
    gl.bindAttribLocation(program, 0, "a_position");

    gl.linkProgram(program);
    uResolutionLoc = null;
    uResolutionLoc = gl.getUniformLocation(program, "u_resolution");

    // The GLSL bytecode is now baked into the program object.
    // These shader handles serve no further purpose but hold driver-side memory.
    gl.detachShader(program, vertexShader);
    gl.detachShader(program, fragmentShader);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        logit("❌ Shader Link Error: " + gl.getProgramInfoLog(program), 3);
        gl.deleteProgram(program); // [B1] Clean up program on link failure too
        return null;
    }

    return program;
}

// ── RENDER LOOP ───────────────────────────────────────────────────────────────
function renderLoop() {
    updateTextureExecutor(cameraElement); 
    rafHandle = requestAnimationFrame(renderLoop);
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", function() {
    logBox = document.getElementById('logs');
    cameraElement = document.getElementById('vid');

    detectWebGPU().then(function(gpuDev) {
        if (gpuDev) {
            gpuDevice        = gpuDev;
            activeRenderPath = 2 /*webgpu*/;
            var ok = initWebGPU();
            if (!ok) {
                // WebGPU init fail — WebGL fallback
                activeRenderPath = 1 /*webgl*/;
                logit('⚠️ [WebGPU] Init failed — falling back to WebGL.', 2);
                init();
            }
            else {
                updateTextureExecutor = renderWebGPU;
            }
        } else {
            activeRenderPath = 1 /*webgl*/;
            init(); // Existing WebGL setup
        }

        settingCamera();

        window.addEventListener('resize', function() {
            currentWidth = window.innerWidth;
            currentHeight = window.innerHeight;
            if (alignHardwareLayersRef) alignHardwareLayersRef();
        });
    });
});

window.addEventListener("beforeunload", function() {
    if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }

    if (webStream) {
        var tracks = webStream.getTracks();
        for (var i = 0; i < tracks.length; i++) { tracks[i].stop(); }
    }

    // WebGPU cleanup
    if (gpuDevice) {
        gpuDevice.destroy(); // GPU resources release karo
        gpuDevice = null;
    }

    gl     = null;
    canvas = null;
});