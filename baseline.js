// Global engine state objects
var curvixStream = null;
var alignHardwareLayersRef = null;

function bootstrapCurvixEngine() {
    console.log("🔍 Bootstrapping Core Engine Infrastructure...");

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

    if (!container || !vid || !gl_overlay || !b_cam) {
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

        console.log("✅ Layers Synchronized: " + wVideo + "x" + hVideo);
    };

    // Core execution pipeline: Start Camera Stream
    function startCameraPipeline() {
        var constraints = {
            audio: false,
            video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
        };

        navigator.mediaDevices.getUserMedia(constraints)
            .then(function(stream) {
                curvixStream = stream;
                
                // Attach listeners securely
                vid.addEventListener('loadedmetadata', alignHardwareLayersRef);
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
        if (curvixStream) {
            var tracks = curvixStream.getTracks();
            for (var i = 0; i < tracks.length; i++) {
                tracks[i].stop();
            }
            // Clean up event listeners to prevent duplicate execution loops
            vid.removeEventListener('loadedmetadata', alignHardwareLayersRef);
            vid.removeEventListener('playing', alignHardwareLayersRef);
            
            vid.srcObject = null;
            curvixStream = null;
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

// Global hook up
window.addEventListener("DOMContentLoaded", bootstrapCurvixEngine);