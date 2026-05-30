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
var logs                   = ['-- logs --------------------'];

function staticDummyExecutor(vid) { /* Safe No-Op: runs before camera is ready */ }
var updateTextureExecutor = updateVideoTextureDirect;

// ── SHADERS ───────────────────────────────────────────────────────────────────
// [VS] Y-flip handled here (free, no pipeline stall) — UNPACK_FLIP_Y_WEBGL stays false
var VS_SOURCE = `
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

var shaderProgram  = null;
var positionBuffer = null;
var canvas         = null;

// ── LIVE LOGS ──────────────────────────────────────────────────────────────────
//A logging system for mobile browsers:
var logBox  = document.getElementById('logs');
function logit(text, mode = 1){
    if (mode === 1){
        //normal mode
        logs = logs + '<br>' +[text];
        console.log(text)
    }
    if (mode === 2){
        //warn mode
        logs = logs + '<br> <span id="warn">' + [text] + '</span>';
        console.warn(text)
    }
    if (mode === 3){
        //error mode
        logs = logs + '<br> <span id="error">' + [text] + '</span>';
        console.error(text)
    }
    logBox.innerHTML = logs;
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

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);                        // Mali-4xx stride crash fix
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

    if (isWebGL2Supported) {
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
        logit("📦 WebGL 2 Immutable VRAM Locked: " + width + "x" + height);
    } else {
        // null ptr → VRAM reserved + zero-initialised.
        // All runtime updates go through texSubImage2D (zero-copy blit into pre-allocated slot).
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        logit("📦 WebGL 1 VRAM Allocated: " + width + "x" + height);
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
        var wVideo = vid.videoWidth;
        var hVideo = vid.videoHeight;
        if (wVideo === 0 || hVideo === 0) return; // Decoder not ready

        var bounds  = container.getBoundingClientRect();
        var wScreen = bounds.width;
        var hScreen = bounds.height;
        if (wScreen === 0 || hScreen === 0) return; // [MISC] Container not yet laid out

        var targetScale  = Math.max(wScreen / wVideo, hScreen / hVideo);
        var targetWidth  = Math.round(wVideo * targetScale); // [B6] Integer canvas dimensions
        var targetHeight = Math.round(hVideo * targetScale); // [B6]

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

        if (!needsVRAMInit) return; // Layout updated above; VRAM already correct

        if (!stagingCanvas) {
            stagingCanvas = document.createElement('canvas');
            // willReadFrequently: false is the DEFAULT — no effect unless set to true.
            // Set true ONLY if getImageData() is called frequently (not this use case).
            stagingCtx = stagingCanvas.getContext('2d', { willReadFrequently: false });
        }
        stagingCanvas.width  = wVideo;
        stagingCanvas.height = hVideo;

        allocateVRAMTexture(wVideo, hVideo); // [B8] No parameter — uses global directly

        if (useCanvasFallback) {
            logit("⚠️ Fallback Mode: Android SurfaceTexture canvas workaround active.", 2);
            updateTextureExecutor = updateVideoTextureCanvasFallback;
        } else {
            logit("🚀 Direct Upload Path Active.");
            updateTextureExecutor = updateVideoTextureDirect;
        }

        logit("✅ Layers Synchronized: " + wVideo + "x" + hVideo);
        logit(`
            <br>
            <b>System Hardware Info:</b>
            <hr>
            <b>Active Native Stream Pipeline:</b><br/>
            ├─ <b>HTML Video Element Res:</b> <span> ${wVideo}x${hVideo} px </span><br/>
            └─ <b>Hardware Track Config:</b> <span> ${wScreen}x${hScreen} px </span><br/>`);
    };

    // ── Camera pipeline ───────────────────────────────────────────────────────
    function startCameraPipeline() {
        var constraints = {
            audio: false,
            video: {
                facingMode: 'environment',
                width:  { ideal: 1280 },
                height: { ideal: 720  }
            }
        };
        navigator.mediaDevices.getUserMedia(constraints)
            .then(function(stream) {
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
            stagingCanvas         = null; // Forces full re-init on next start
            stagingCtx            = null;

            // [B10] Cancel rAF — no point running an empty loop when camera is off
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

    startCameraPipeline(); // Fire on load
}

// ── TEXTURE UPDATE FUNCTIONS ──────────────────────────────────────────────────
function updateVideoTextureDirect(videoElement) {
    // currentTime equality guard: prevents redundant uploads when no new frame decoded
    if (videoElement.currentTime === lastFrameTime || videoElement.readyState < 2) return;
    lastFrameTime = videoElement.currentTime;
    gl.bindTexture(gl.TEXTURE_2D, vidtex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function updateVideoTextureCanvasFallback(videoElement) {
    if (videoElement.currentTime === lastFrameTime || videoElement.readyState < 2) return;
    lastFrameTime = videoElement.currentTime;
    // Intermediate CPU blit: compositor sees canvas bitmap, not the locked EGLImage/SurfaceTexture
    stagingCtx.drawImage(videoElement, 0, 0, stagingCanvas.width, stagingCanvas.height);
    gl.bindTexture(gl.TEXTURE_2D, vidtex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, stagingCanvas);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
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
    init();
    cameraElement = document.getElementById('vid');
    settingCamera();

    rafHandle = requestAnimationFrame(renderLoop);

    // Realign on device orientation flip or window resize
    window.addEventListener('resize', function() {
        if (alignHardwareLayersRef) { alignHardwareLayersRef(); }
    });
});

window.addEventListener("beforeunload", function() {
    if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }

    if (webStream) {
        var tracks = webStream.getTracks();
        for (var i = 0; i < tracks.length; i++) { tracks[i].stop(); }
    }

    gl     = null;
    canvas = null;
});