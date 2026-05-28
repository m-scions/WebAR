// Global engine state objects
var webStream = null;
var alignHardwareLayersRef = null;
var vidtex = null;
var lastFrameTime = -1;
var isWebGL2Supported = false;
var gl = null;
var posAttributeLocation = null;
var textureLocation = null;
var stagingCanvas = null;
var stagingCtx = null;
var useCanvasFallback = true;
var cameraElement = null; // Global pointer
function staticDummyExecutor(vid) { /* Safe No-Op */ }
var updateTextureExecutor = staticDummyExecutor;
// --- shader source string ---:

// Vertex Shader:
var VS_SOURCE = `
    attribute vec2 a_position;
    varying vec2 v_texCoord;

    void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        vec2 rawTexCoord = a_position * 0.5 + 0.5;
        v_texCoord = vec2(rawTexCoord.x, 1.0 - rawTexCoord.y);
    }
`;

// Fragment Shader:
var FS_SOURCE = `
    precision mediump float;
    varying vec2 v_texCoord;
    uniform sampler2D u_cameraTexture;

    void main() {
        gl_FragColor = texture2D(u_cameraTexture, v_texCoord);
    }
`;

// Global variable to hold compiled shaders:
var shaderProgram = null;
var positionBuffer = null;

// Declare global WebGL hooks (initialized once DOM loads)
var canvas = null;

// Function to initialize WebGL states
function init() {
    canvas = document.querySelector("#gl_overlay");
    
    var gl2Context = canvas.getContext("webgl2");
    if (gl2Context) {
        gl = gl2Context;
        isWebGL2Supported = true;
        console.log("WebGL 2 supported!");
    } else {
        gl = canvas.getContext("webgl");
        console.log("WebGL 1 supported fallback!");
    }
    
    if (!gl) {
        console.error("❌ CRITICAL: WebGL context creation failed.");
        return;
    }

    // 1. Row padding zero karo (Tightly pack single-channel 1-byte data)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    // 2. Color space conversion band karo (No sRGB processing overhead)
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);

    // 3. Premultiply alpha lock karo (Don't waste cycles multiplying channels)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    console.log("initalization done!")

    // --- SHADER COMPILATION & LINKING ---
    shaderProgram = createWebGLProgram(VS_SOURCE, FS_SOURCE);
    if (!shaderProgram) {
        console.error("❌ Shader setup failed.");
        return;
    }

    // --- GEOMETRY SETUP (Full-Screen Quad Buffer) ---
    // Hum 2 Triangles ke 4 corners (X, Y) banayenge jo poore canvas ko cover karein (-1 se 1)
    var vertices = new Float32Array([
        -1.0, -1.0,  // Bottom-Left
         1.0, -1.0,  // Bottom-Right
        -1.0,  1.0,  // Top-Left
         1.0,  1.0   // Top-Right
    ]);

    positionBuffer = gl.createBuffer(); // GPU memory mein geometry box banao
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer); // Select karo is box ko
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW); // Data upload kar do

    var debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo) {
        var gpuName = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        console.log("📱 Engine Hardware Analysis - GPU Identified:", gpuName);

        // Comprehensive Regex Filter: Scan for ALL old problematic silicon series
        var isLegacyGPU = gpuName.indexOf("Mali-400") !== -1 || 
                          gpuName.indexOf("Mali-T6") !== -1 ||
                          gpuName.indexOf("Adreno (TM) 3") !== -1 || 
                          gpuName.indexOf("PowerVR SGX") !== -1 ||
                          gpuName.indexOf("Tegra") !== -1 ||
                          gpuName.indexOf("Vivante") !== -1;

        if (!isLegacyGPU) {
            useCanvasFallback = false; // Verified safe modern chip, safe to unlock zero-copy direct upload
        }
    }
    
    //update video texture to gpu varibale setting once:
    posAttributeLocation = gl.getAttribLocation(shaderProgram, "a_position");
    textureLocation = gl.getUniformLocation(shaderProgram, "u_cameraTexture");
    
    gl.enableVertexAttribArray(posAttributeLocation);
    
    // --- HOISTED STATE BINDINGS (Add these 3 lines here permanently) ---
    gl.useProgram(shaderProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(posAttributeLocation, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(textureLocation, 0);

    console.log("✅ Initialization & Shaders compilation done!");
};

//function to allocate data to vram:
function allocateVRAMTexture(width, height, isWebGL2) {
    
    // 1. Agar texture pehle se bana hua hai, toh purana delete karo (Memory clear) - INTACT!
    if (vidtex) { gl.deleteTexture(vidtex); }

    // 2. GPU mein ek naya texture ID/Pointer generate karo - INTACT!
    vidtex = gl.createTexture();

    // 3. State Machine Active karo: Is texture pointer ko select karo - INTACT!
    gl.bindTexture(gl.TEXTURE_2D, vidtex);

    // Hardened PixelStore guardrails embedded perfectly right during allocation
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);       // Mali-400 stride crash fix
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // Adreno 3xx NPOT freeze prevention
    if (gl.UNPACK_COLORSPACE_CONVERSION_WEBGL) {
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE); // Color-matrix bypass
    }

    // 4. Texture filtering settings lagao (Performance ke liye NEAREST use karo) - INTACT!
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); 
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // 5. Hardened Full RGBA Format Block Allocation (Bypasses single-channel issues)
    // WebGL 2 aur WebGL 1 dono natively gl.RGBA ko DMA transfer speed par hardware surface par space lock karte hain.

    // allocateVRAMTexture ke andar gl.texImage2D waali line ko isse replace karo:
    if (isWebGL2Supported) {
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
        console.log("📦 WebGL 2 Immutable VRAM Locked: " + width + "x" + height);
    } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        console.log("📦 WebGL 1 Mutable VRAM Allocated: " + width + "x" + height);
    }    

    console.log("📦 VRAM Reserved for RGBA Resolution: " + width + "x" + height);
}

function settingCamera() {
    // 1. Legacy Polyfill Layer for Android 6 Media Devices
    if (!navigator.mediaDevices) { navigator.mediaDevices = {}; }
    if (!navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia = function(constraints) {
            var getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
            if (!getUserMedia) { return Promise.reject(new Error('UserMedia API missing')); }
            return new Promise(function(resolve, reject) {
                getUserMedia.call(navigator, constraints, resolve, reject);
            });
        };
    }

    // Capture DOM nodes EXACTLY ONCE at bootup
    var container = document.getElementById('curvix-container');
    var vid = document.getElementById('vid');
    var gl_overlay = document.getElementById('gl_overlay');
    var b_cam = document.getElementById('b_cam_input');
    var debugPanel = document.getElementById('camera-debug-panel');

    if (!container || !vid || !gl_overlay || !b_cam || !debugPanel) {
        console.error("❌ CRITICAL: DOM node link failure.");
        return;
    }

    // Safe reference wrapper for layout calculation
    alignHardwareLayersRef = function() {
        var wVideo = vid.videoWidth;
        var hVideo = vid.videoHeight;
        if (wVideo === 0 || hVideo === 0) return;

        var bounds = container.getBoundingClientRect();
        var wScreen = bounds.width;
        var hScreen = bounds.height;

        var scaleX = wScreen / wVideo;
        var scaleY = hScreen / hVideo;
        var targetScale = Math.max(scaleX, scaleY);

        vid.style.width = (wVideo * targetScale) + "px";
        vid.style.height = (hVideo * targetScale) + "px";

        var targetWidth = wVideo * targetScale;
        var targetHeight = hVideo * targetScale;

        gl_overlay.width = targetWidth;
        gl_overlay.height = targetHeight;
        gl_overlay.style.width = targetWidth + "px";
        gl_overlay.style.height = targetHeight + "px";

        if (gl) {
            gl.viewport(0, 0, targetWidth, targetHeight);
        }       

        if (stagingCanvas && stagingCanvas.width === wVideo && stagingCanvas.height === hVideo) return; 

        if (!stagingCanvas) {
            stagingCanvas = document.createElement('canvas');
            // willReadFrequently: false lagane se browser ise pure GPU-accelerated memory mein rakhta hai
            stagingCtx = stagingCanvas.getContext('2d', { willReadFrequently: false });
        }

        stagingCanvas.width = wVideo;
        stagingCanvas.height = hVideo;

        //allocating to vram:
        allocateVRAMTexture(wVideo, hVideo, isWebGL2Supported);

        if (useCanvasFallback) {
            console.warn("⚠️ Fallback Mode Activated for Legacy Stack.");
            updateTextureExecutor = updateVideoTextureCanvasFallback;
        } else {
            console.log("🚀 High-Performance Direct Upload Path Armed.");
            updateTextureExecutor = updateVideoTextureDirect;
        }

        console.log("✅ Layers Synchronized: " + wVideo + "x" + hVideo);

        debugPanel.innerHTML = `
                <h1>System Hardware Info:</h1>
                <hr>
                <b>Active Native Stream Pipeline:</b><br/>
                ├─ <b>HTML Video Element Res:</b> <span> ${wVideo}x${hVideo} px </span> <br/>
                └─ <b>Hardware Track Config:</b> <span> ${wScreen}x${hScreen} px </span> <br/>`;
    };

    // Core execution pipeline: Start Camera Stream
    function startCameraPipeline() {
        var constraints = {
            audio: false,
            video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
        };

        navigator.mediaDevices.getUserMedia(constraints)
            .then(function(stream) {
                webStream = stream;
                
                // Attach listeners securely
                // vid.addEventListener('loadedmetadata', alignHardwareLayersRef);
                vid.addEventListener('playing', alignHardwareLayersRef);

                vid.srcObject = stream;
                var playPromise = vid.play();
                if (playPromise !== undefined) {
                    playPromise.catch(function(e) { console.error("Autoplay blocked:", e); });
                }
                console.log("🚀 Camera hardware linked successfully.");
            })
            .catch(function(err) {
                console.error("❌ CRITICAL: Hardware rejected pipeline.", err);
                alert("Hardware Stream Failure: " + err.name);
            });
    }

    // Core execution pipeline: Stop Camera Stream cleanly
    function stopCameraPipeline() {
        if (webStream) {
            var tracks = webStream.getTracks();
            for (var i = 0; i < tracks.length; i++) {
                tracks[i].stop();
            }
            // Clean up event listeners to prevent duplicate execution loops
            // vid.removeEventListener('loadedmetadata', alignHardwareLayersRef);
            vid.removeEventListener('playing', alignHardwareLayersRef);
            
            vid.srcObject = null;
            webStream = null;
            
            vid.load();
            gl.bindTexture(gl.TEXTURE_2D, null);

            // 💡 STATE RESET: Wapas dummy no-op function par switch karo
            updateTextureExecutor = staticDummyExecutor;
            lastFrameTime = -1; // 🚀 RESET STATE
            stagingCanvas = null; // 🚀 CRITICAL FIX: To prevent re-initialization deadlock bug
            stagingCtx = null;

            console.log("🛑 Pipeline cut and memory references unlinked.");
        }
    }

    // Setup the Toggle Event Listener EXACTLY ONCE
    b_cam.addEventListener('change', function() {
        if (b_cam.checked) {
            stopCameraPipeline();
        } else {
            console.log("⏳ Re-initializing Camera Engine cleanly...");
            startCameraPipeline();
        }
    });

    // Fire the initial camera activation loop on load
    startCameraPipeline();
}

function updateVideoTextureDirect(videoElement) {
    // Same-frame time matching layer: stops redundant calculations and bus stalls - INTACT!
    if (videoElement.currentTime === lastFrameTime || videoElement.readyState < 2) return;

    lastFrameTime = videoElement.currentTime; // Caching frame execution pointer - INTACT!

    gl.bindTexture(gl.TEXTURE_2D, vidtex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function updateVideoTextureCanvasFallback(videoElement) {
    if (videoElement.currentTime === lastFrameTime || videoElement.readyState < 2) return;
    lastFrameTime = videoElement.currentTime;

    stagingCtx.drawImage(videoElement, 0, 0, stagingCanvas.width, stagingCanvas.height);

    gl.bindTexture(gl.TEXTURE_2D, vidtex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, stagingCanvas);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function compileShaderWorker(source, type) {
    var shader = gl.createShader(type); // GPU mein khali shader box banao
    gl.shaderSource(shader, source);    // GLSL string usme load karo
    gl.compileShader(shader);           // Hardware compilation trigger karo

    // Check karo compile sahi se hua ya nahi
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error("❌ GLSL Compile Error: " + gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function createWebGLProgram(vsSource, fsSource) {
    var vertexShader = compileShaderWorker(vsSource, gl.VERTEX_SHADER);
    var fragmentShader = compileShaderWorker(fsSource, gl.FRAGMENT_SHADER);

    if (!vertexShader || !fragmentShader) return null;

    var program = gl.createProgram(); // Final executable pipeline box
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);

    gl.bindAttribLocation(program, 0, "a_position");

    gl.linkProgram(program);          // Dono ko link karo

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error("❌ Shader Program Link Error: " + gl.getProgramInfoLog(program));
        return null;
    }
    return program;
}

function renderLoop() {
    updateTextureExecutor(cameraElement);
    requestAnimationFrame(renderLoop);
}

// Global hook up
window.addEventListener("DOMContentLoaded", function() {
    init();
    cameraElement = document.getElementById('vid');
    settingCamera();   
    renderLoop();

    // 🚀 RESPONSIVENESS CAPABILITY: Triggers realignment on device orientation flip or window resizing
    window.addEventListener('resize', function() {
        if (alignHardwareLayersRef) {
            alignHardwareLayersRef();
        }
    });
});

window.addEventListener("beforeunload", function() {
    if (webStream) {
        var tracks = webStream.getTracks();
        for (var i = 0; i < tracks.length; i++) { tracks[i].stop(); }
    }
    gl = null;
    canvas = null;
});