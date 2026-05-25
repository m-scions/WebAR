// Global engine state objects
var webStream = null;
var alignHardwareLayersRef = null;
var vidtex = null;
var lastFrameTime = -1;
var isWebGL2Supported = false;

// Declare global WebGL hooks (initialized once DOM loads)
var canvas = null;
var gl = null;

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
};


//function to allocate data to vram:
function allocateVRAMTexture(width, height, isWebGL2) {
    
    // 1. Agar texture pehle se bana hua hai, toh purana delete karo (Memory clear)
    if (vidtex) { gl.deleteTexture(vidtex); }

    // 2. GPU mein ek naya texture ID/Pointer generate karo
    vidtex = gl.createTexture();

    // 3. State Machine Active karo: Is texture pointer ko select karo
    gl.bindTexture(gl.TEXTURE_2D, vidtex);

    // 4. Texture filtering settings lagao (Performance ke liye NEAREST use karo)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); 
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // 5. Check format according to WebGL version (Hardware allocation hack)
    if (isWebGL2) {
        // WebGL 2.0: Use modern single-channel R8 (Red Channel)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    } else {
        // WebGL 1.0 Fallback: Use safe legacy ALPHA channel
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, width, height, 0, gl.ALPHA, gl.UNSIGNED_BYTE, null);
    }
    
    console.log("📦 VRAM Reserved for Resolution: " + width + "x" + height);
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

        gl_overlay.width = wScreen;
        gl_overlay.height = hScreen;
        gl_overlay.style.width = wScreen + "px";
        gl_overlay.style.height = hScreen + "px";

        
        //allocating to vram:
        allocateVRAMTexture(wVideo, hVideo, isWebGL2Supported);

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

function updateVideoTextureToGPU(videoElement, isWebGL2) {
    if (!gl || !vidtex || !videoElement) {
        return; // Safe exit (~0ms CPU load) - Saare errors/warnings yahin block ho gaye!
    }

    if (videoElement.currentTime === lastFrameTime || videoElement.readyState < 2) {
        return;
    }

    lastFrameTime = videoElement.currentTime;

    gl.bindTexture(gl.TEXTURE_2D, vidtex);

    var format = isWebGL2 ? gl.RED : gl.ALPHA;

    //Zero reallocation, pure GPU-to-GPU memory transfer
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, format, gl.UNSIGNED_BYTE, videoElement);
}

// Global hook up
window.addEventListener("DOMContentLoaded", function() {
    init();
    settingCamera();

    var cameraElement = document.getElementById('vid');
    
    function renderLoop() {
        if (cameraElement && webStream) {
            updateVideoTextureToGPU(cameraElement, isWebGL2Supported);
        }
        requestAnimationFrame(renderLoop);
    }
    
    renderLoop();
});

window.addEventListener("beforeunload", function() {
    if (webStream) {
        var tracks = webStream.getTracks();
        for (var i = 0; i < tracks.length; i++) { tracks[i].stop(); }
    }
    gl = null;
    canvas = null;
});