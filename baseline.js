function initializeCurvixEngine() {
    console.log("🔍 Initializing Core Engine Baseline...");

    // 1. Legacy Polyfill Layer for Android 6 Media Devices
    if (!navigator.mediaDevices) {
        navigator.mediaDevices = {};
    }
    if (!navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia = function(constraints) {
            var getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
            if (!getUserMedia) {
                return Promise.reject(new Error('UserMedia API missing in this browser context'));
            }
            return new Promise(function(resolve, reject) {
                getUserMedia.call(navigator, constraints, resolve, reject);
            });
        };
    }

    var container = document.getElementById('curvix-container');
    var vid = document.getElementById('vid');
    var gl_overlay = document.getElementById('gl_overlay');


    // 2. DOM Safeguard
    if (!container || !vid || !gl_overlay) {
        console.error("❌ CRITICAL: DOM node link failure.");
        return;
    }

    // Standard hardware negotiation constraints profile
    var constraints = {
        audio: false,
        video: {
            facingMode: 'environment',
            width: { ideal: 1280 },
            height: { ideal: 720 }
        }
    };

    // Branchless layer composition execution loop
    function alignHardwareLayers() {
        var wVideo = vid.videoWidth;
        var hVideo = vid.videoHeight;

        if (wVideo === 0 || hVideo === 0) return;

        // Extract safe viewable area bounds excluding virtual system elements
        var bounds = container.getBoundingClientRect();
        var wScreen = bounds.width;
        var hScreen = bounds.height;

        // High-speed branchless scaling computation
        var scaleX = wScreen / wVideo;
        var scaleY = hScreen / hVideo;
        var targetScale = Math.max(scaleX, scaleY); // Compiled to native assembly conditional moves

        var wRendered = wVideo * targetScale;
        var hRendered = hVideo * targetScale;

        // Apply physical metrics directly to hardware display layout nodes
        vid.style.width = wRendered + "px";
        vid.style.height = hRendered + "px";

        // Lock internal canvas buffer dimensions to screen size to eliminate linear scaling blur
        gl_overlay.width = wScreen;
        gl_overlay.height = hScreen;
        gl_overlay.style.width = wScreen + "px";
        gl_overlay.style.height = hScreen + "px";

        console.log("✅ Layers Locked. Matrix: " + wVideo + "x" + hVideo + " -> Canvas Bounds: " + wScreen + "x" + hScreen);
    }

    // 3. Native Pipeline Activation via ES6 Promise chains (Safe for Android 6+)
    navigator.mediaDevices.getUserMedia(constraints)
        .then(function(stream) {
            // Register hardware listeners before piping stream to bypass lifecycle race conditions
            vid.addEventListener('loadedmetadata', alignHardwareLayers);
            vid.addEventListener('playing', alignHardwareLayers);

            vid.srcObject = stream;
            
            var playPromise = vid.play();
            if (playPromise !== undefined) {
                playPromise.catch(function(e) {
                    console.error("Autoplay rejected by mobile security engine:", e);
                });
            }
            
            console.log("🚀 Camera link path unlocked successfully.");
        })
        .catch(function(hardwareError) {
            console.error("❌ CRITICAL: Pipeline access rejected by hardware driver.", hardwareError);
            alert("Hardware Stream Failure: " + hardwareError.name);
        });


    // 4. Track Muting Switch (Paste at the bottom inside initializeCurvixEngine)
    var b_cam = document.getElementById('b_cam_input');
    
    b_cam.addEventListener('change', function() {
    // NOTE: Agar tumhara checkbox check hone par camera OFF hota hai:
        if (b_cam.checked) {
            if (vid.srcObject) {
                var stream = vid.srcObject;
                var tracks = stream.getTracks();
                
                // 1. Saare tracks ko safe loop se stop karo (sirf 0 waale ko nahi)
                for (var i = 0; i < tracks.length; i++) {
                    tracks[i].stop();
                }
                
                // 2. Video element se link todo taaki browser RAM free kar sake (No Leak!)
                vid.srcObject = null; 
                console.log("🛑 Camera hardware turned OFF & memory references cleared.");
            }
        } else {
            console.log("⏳ Re-initializing Camera Engine smoothly without reload...");
            
            // 3. Page reload karne ki jagah direct core function ko firse call karo!
            initializeCurvixEngine(); 
        }    
    });

}

// Safely execute once layout tree structure is parsed completely
window.addEventListener("DOMContentLoaded", initializeCurvixEngine);