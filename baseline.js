// Global engine state objects
var webStream = null;
var alignHardwareLayersRef = null;
var vidtex = null;
var lastFrameTime = -1;
var isWebGL2Supported = false;
var gl = null;
var posAttributeLocation = null;
var textureLocation = null;

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
    
    
    //update video texture to gpu varibale setting once:
    posAttributeLocation = gl.getAttribLocation(shaderProgram, "a_position");
    textureLocation = gl.getUniformLocation(shaderProgram, "u_cameraTexture");
    
    gl.enableVertexAttribArray(posAttributeLocation);

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
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // 5. Hardened Full RGBA Format Block Allocation (Bypasses single-channel issues)
    // WebGL 2 aur WebGL 1 dono natively gl.RGBA ko DMA transfer speed par hardware surface par space lock karte hain.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    
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

        gl_overlay.width = wScreen;
        gl_overlay.height = hScreen;
        gl_overlay.style.width = wScreen/5 + "px";
        gl_overlay.style.height = hScreen/5 + "px";

        if (gl) {
            gl.viewport(0, 0, wScreen, hScreen);
        }

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
            
            vid.load();
            gl.bindTexture(gl.TEXTURE_2D, null);

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
        return; // Safe exit (~0ms CPU load) - Saare errors/warnings yahin block ho gaye! - INTACT!
    }

    // Same-frame time matching layer: stops redundant calculations and bus stalls - INTACT!
    if (videoElement.currentTime === lastFrameTime || videoElement.readyState < 2) {
        return;
    }

    lastFrameTime = videoElement.currentTime; // Caching frame execution pointer - INTACT!

    gl.bindTexture(gl.TEXTURE_2D, vidtex);

    // Strictly Full-Color Native Format for absolute zero-copy hardware decoding pass
    var format = gl.RGBA;

    // Zero reallocation, pure GPU-to-GPU memory transfer - INTACT!
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, format, gl.UNSIGNED_BYTE, videoElement);

    // steps for drawing the gpu texture in screen: - INTACT!
    gl.useProgram(shaderProgram);

    // Geometry Buffer connceting to 'a_position' variable - INTACT!
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(posAttributeLocation, 2, gl.FLOAT, false, 0, 0);

    // Removed the u_isWebGL2 logic since we now uniformly feed full RGBA color channel textures.
    // Kept the attribute binding block intact as per your runtime order strategy!
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, vidtex);
    gl.uniform1i(textureLocation, 0);

    // Drawing using exact ultra-lightweight triangle strip with 4 optimized vertices - INTACT!
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
    gl.linkProgram(program);          // Dono ko link karo

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error("❌ Shader Program Link Error: " + gl.getProgramInfoLog(program));
        return null;
    }
    return program;
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