import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
// GLTFLoader is no longer needed as the 3D ship model is removed

// --- Scene Setup ---
let scene, camera, renderer, controls;
let shipGroup; // Group to hold all containers
let sea; // Simple sea plane

// --- Global variable to store structural data ---
let shipStructuralData = null;
let currentContainerMeshes = []; // To keep track of all container meshes for search/reset

const CONTAINER_DIMENSIONS = {
    '20ft': { length: 6.096, width: 2.438, height: 2.591 },
    '40ft': { length: 12.192, width: 2.438, height: 2.591 },
    '45ft': { length: 13.716, width: 2.438, height: 2.591 },
};

// --- Tier mapping for "below deck" visualization ---
const ON_DECK_TIER_MIN_THRESHOLD = 72; // Assuming tiers >= 72 are on deck from your data sample

// Define the water level (Y=0 is a good standard for a waterline)
const WATER_LEVEL = 0;

// Define the Y-coordinate for the *bottom* of the lowest container in each group
const Y_HOLD_BOTTOM_OF_LOWEST_TIER = 1; // Lowest hold container bottom at Y=1 (above sea)
const Y_DECK_BOTTOM_OF_LOWEST_TIER = 15; // Lowest deck container bottom at Y=15 (creating gap)


function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87CEEB); // Sky blue background

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000); // Increased far clipping plane
    // Initial camera position for a wider view to see all containers
    camera.position.set(0, 80, 200);
    camera.lookAt(0, 0, 0); // Look at the center of the scene

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio); // Improve rendering quality on high-DPI screens
    document.body.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.25;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(100, 150, 100);
    directionalLight.castShadow = true;
    scene.add(directionalLight);

    shipGroup = new THREE.Group();
    scene.add(shipGroup);

    // --- Simple Sea Plane ---
    const seaGeometry = new THREE.PlaneGeometry(5000, 5000); // Even larger plane for the sea
    const seaMaterial = new THREE.MeshPhongMaterial({
        color: 0x0077be, // Blue color for sea
        side: THREE.DoubleSide,
        transparent: true, // Make sea transparent
        opacity: 0.6,      // Adjust opacity to see through
        depthWrite: false, // Crucial: don't write to depth buffer so objects behind are visible
    });
    sea = new THREE.Mesh(seaGeometry, seaMaterial);
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = WATER_LEVEL; // Sea surface at Y = 0 (fixed waterline)
    sea.receiveShadow = true;
    sea.renderOrder = 1; // Render sea after containers (containers implicitly have renderOrder 0)
    scene.add(sea);
    // --- End Sea setup ---

    // Add a GridHelper to help visualize the scene and confirm rendering
    const gridHelper = new THREE.GridHelper(500, 50); // Larger grid for better visualization
    scene.add(gridHelper);

    window.addEventListener('resize', onWindowResize, false);
    document.getElementById('file-input').addEventListener('change', handleFileSelect, false);

    setupSearchListeners(); // Setup search button listeners

    // --- Load ship structural data first ---
    loadShipStructuralData();

    animate();
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

// --- FUNCTION: Load ship structural data ---
async function loadShipStructuralData() {
    try {
        const response = await fetch('ship_structure.json'); // Path to your structural JSON file
        shipStructuralData = await response.json();
        console.log("Ship Structural Data Loaded:", shipStructuralData);

        // Pre-process Rows_Tiers_per_Bay for faster lookup
        // Convert array to a Map for O(1) access by bay number
        const rowsTiersMap = new Map();
        if (shipStructuralData.Rows_Tiers_per_Bay) {
            shipStructuralData.Rows_Tiers_per_Bay.forEach(item => {
                rowsTiersMap.set(item.bay, item);
            });
        }
        shipStructuralData.rowsTiersMap = rowsTiersMap; // Store the map for later use

    } catch (error) {
        console.error("Error loading ship structural data:", error);
        alert("Could not load ship structure data (ship_structure.json). Please ensure the file exists and is valid JSON.");
        // If structural data isn't loaded, container placement won't work correctly.
    }
}


function handleFileSelect(event) {
    if (!shipStructuralData) {
        alert("Ship structural data is still loading or failed to load. Please wait or check console for errors.");
        return;
    }

    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                console.log("Container Data File loaded:", data);
                clearContainers(); // Clears all existing containers
                placeAndFrameContainers(data); // Call this to place and frame containers
            } catch (error) {
                console.error("Error parsing JSON file:", error);
                alert("Invalid JSON file. Please upload a valid JSON.");
            }
        };
        reader.readAsText(file);
    }
}

function clearContainers() {
    // Remove all children from shipGroup (which are now only containers)
    while(shipGroup.children.length > 0){
        const object = shipGroup.children[0];
        if (object.geometry) object.geometry.dispose();
        if (object.material) {
            if (Array.isArray(object.material)) {
                object.material.forEach(m => m.dispose());
            } else {
                object.material.dispose();
            }
        }
        shipGroup.remove(object);
    }
    currentContainerMeshes = []; // Clear the array of references
}


// This function places containers and adjusts camera/sea based on them.
async function placeAndFrameContainers(containerData) {
    placeContainers(containerData);

    // After placing containers, adjust the camera to frame them.
    if (currentContainerMeshes.length > 0) {
        const containerGroupForBoundingBox = new THREE.Group();
        currentContainerMeshes.forEach(mesh => containerGroupForBoundingBox.add(mesh.clone())); // Clone to avoid direct scene graph modification
        const containerBoundingBox = new THREE.Box3().setFromObject(containerGroupForBoundingBox);
        const containerCenter = new THREE.Vector3();
        containerBoundingBox.getCenter(containerCenter);
        const containerSize = new THREE.Vector3();
        containerBoundingBox.getSize(containerSize);

        const maxDim = Math.max(containerSize.x, containerSize.y, containerSize.z);
        const fov = camera.fov * (Math.PI / 180);
        let cameraDistance = Math.abs(maxDim / 2 / Math.tan(fov / 2));
        cameraDistance *= 1.5; // Add some padding

        camera.position.set(containerCenter.x, containerCenter.y + containerSize.y * 0.75, cameraDistance + containerCenter.z);
        controls.target.set(containerCenter.x, containerCenter.y, containerCenter.z);
        controls.update();

        // Sea position is fixed at WATER_LEVEL in init(), no dynamic adjustment here.
    } else {
        console.warn("No containers loaded, camera position is default.");
    }
}


// --- UPDATED: getContainerPosition function using structural data ---
function getContainerPosition(bay, row, tier, containerType) {
    const dims = CONTAINER_DIMENSIONS[containerType];
    if (!dims || !shipStructuralData) {
        console.error("Missing container dimensions or ship structural data.");
        return { x: 0, y: 0, z: 0 };
    }

    let y; // Declared y here to avoid ReferenceError

    // --- X-coordinate (Longitudinal - LCG) ---
    let x = shipStructuralData.LCG[bay];
    if (x === undefined) {
        console.warn(`LCG value not found for bay ${bay}. Using 0 for X.`);
        x = 0;
    }

    const lcgValues = Object.values(shipStructuralData.LCG);
    const minLcg = Math.min(...lcgValues);
    const maxLcg = Math.max(...lcgValues);
    const lcgCenterOffset = (minLcg + maxLcg) / 2;

    x -= lcgCenterOffset; // Offset to center the LCG range around shipGroup's X=0

    // --- Z-coordinate (Transverse - TCG) ---
    let z;
    const tcgBayKey = shipStructuralData.TCG_bay_mapping[bay]; // Check for bay-specific TCG
    const tcgSource = tcgBayKey ? shipStructuralData.TCG[tcgBayKey] : shipStructuralData.TCG.general;

    z = tcgSource[row];
    if (z === undefined) {
        console.warn(`TCG value not found for row ${row} in bay ${bay} (or general). Using 0 for Z.`);
        z = 0;
    }

    // --- Y-coordinate (Vertical - Tier) ---
    const bayRowTierInfo = shipStructuralData.rowsTiersMap.get(bay);
    if (!bayRowTierInfo) {
        console.warn(`Row/Tier info not found for bay ${bay}. Using default tier calculation.`);
        // Fallback for missing structural data: place them above water for visibility
        // This ensures the lowest container is above WATER_LEVEL (Y=0)
        const Y_BASE_CONTAINER_CENTER_DEFAULT = WATER_LEVEL + (CONTAINER_DIMENSIONS['20ft'].height / 2) + 0.5; // 0.5 units above water
        y = Y_BASE_CONTAINER_CENTER_DEFAULT + (tier * CONTAINER_DIMENSIONS['20ft'].height);
    } else {
        let relativeTier = tier - bayRowTierInfo.tier_start;
        if (relativeTier < 0) {
            console.warn(`Container tier ${tier} is below starting tier ${bayRowTierInfo.tier_start} for bay ${bay}. Adjusting to lowest possible.`);
            relativeTier = 0;
        }

        // Determine the base Y-level based on whether it's "below deck" or "on deck"
        const isBelowDeck = tier < ON_DECK_TIER_MIN_THRESHOLD;
        let base_y_for_tier_bottom; // This will be the Y-coordinate for the *bottom* of the lowest container in this group

        if (isBelowDeck) {
            // Containers in the hold (below deck) will now be placed above WATER_LEVEL
            base_y_for_tier_bottom = Y_HOLD_BOTTOM_OF_LOWEST_TIER;
        } else {
            // Containers on deck will also be placed above WATER_LEVEL, but higher
            base_y_for_tier_bottom = Y_DECK_BOTTOM_OF_LOWEST_TIER;
        }

        // Calculate Y-coordinate for the *center* of the current container
        y = base_y_for_tier_bottom + (relativeTier * CONTAINER_DIMENSIONS['20ft'].height) + (dims.height / 2);
    }

    return { x, y, z };
}


function placeContainers(containerData) {
    console.log("placeContainers called with:", containerData.length, "items."); // New log for debugging

    // Standard materials
    const material20ft = new THREE.MeshPhongMaterial({ color: 0xff0000, flatShading: true }); // Red
    const material40ft = new THREE.MeshPhongMaterial({ color: 0x00ff00, flatShading: true }); // Green
    const material45ft = new THREE.MeshPhongMaterial({ color: 0x0000ff, flatShading: true }); // Blue

    // Re-introducing materialBelowDeck for the yellow transparent look as requested previously
    // and ensuring it's used based on isBelowDeck.
    const materialBelowDeck = new THREE.MeshPhongMaterial({ color: 0xffff00, transparent: true, opacity: 0.7, flatShading: true, depthWrite: true }); // Yellow, semi-transparent

    const highlightMaterial = new THREE.MeshPhongMaterial({ color: 0xff00ff, flatShading: true, emissive: 0xaa00aa, emissiveIntensity: 0.5 }); // Magenta highlight

    const geometry20ft = new THREE.BoxGeometry(CONTAINER_DIMENSIONS['20ft'].length, CONTAINER_DIMENSIONS['20ft'].height, CONTAINER_DIMENSIONS['20ft'].width);
    const geometry40ft = new THREE.BoxGeometry(CONTAINER_DIMENSIONS['40ft'].length, CONTAINER_DIMENSIONS['40ft'].height, CONTAINER_DIMENSIONS['40ft'].width);
    const geometry45ft = new THREE.BoxGeometry(CONTAINER_DIMENSIONS['45ft'].length, CONTAINER_DIMENSIONS['45ft'].height, CONTAINER_DIMENSIONS['45ft'].width);

    currentContainerMeshes = []; // Reset list for new set of containers

    containerData.forEach((containerInfo, index) => {
        console.log(`Processing container at index ${index}:`, containerInfo); // New log for debugging

        // Ensure all required properties exist, including 'id' now
        if (typeof containerInfo.id === 'undefined' || typeof containerInfo.bay === 'undefined' ||
            typeof containerInfo.row === 'undefined' || typeof containerInfo.tier === 'undefined' ||
            typeof containerInfo.size === 'undefined') {
            console.warn(`Skipping malformed container data at index ${index}: missing ID or other critical property.`, containerInfo);
            return;
        }

        const { id, bay, row, tier, size } = containerInfo; // Destructure ID

        const position = getContainerPosition(bay, row, tier, size);
        let geometry;

        switch (size) {
            case '20ft':
                geometry = geometry20ft;
                break;
            case '40ft':
                geometry = geometry40ft;
                break;
            case '45ft':
                geometry = geometry45ft; // Corrected typo here
                break;
            default:
                console.warn(`Unknown container size: "${size}". Skipping container at bay:${bay}, row:${row}, tier:${tier}`); // New log for debugging
                return;
        }

        const isBelowDeck = tier < ON_DECK_TIER_MIN_THRESHOLD;
        // Material assignment: use yellow transparent for below deck, solid for on deck
        let originalMaterial;
        if (isBelowDeck) {
            originalMaterial = materialBelowDeck.clone(); // Use yellow transparent for below deck
        } else {
            if (size === '20ft') originalMaterial = material20ft.clone();
            else if (size === '40ft') originalMaterial = material40ft.clone();
            else originalMaterial = material45ft.clone();
        }


        const containerMesh = new THREE.Mesh(geometry, originalMaterial);
        containerMesh.position.set(position.x, position.y, position.z);
        containerMesh.castShadow = true;
        containerMesh.receiveShadow = true;
        containerMesh.renderOrder = 0; // Ensure containers are rendered before the sea

        // Store original info and material in userData for search/reset, INCLUDING ID
        containerMesh.userData = {
            id: id, // Store the container ID
            bay: bay,
            row: row,
            tier: tier,
            size: size,
            isBelowDeck: isBelowDeck,
            originalMaterial: originalMaterial,
            highlightMaterial: highlightMaterial // Store highlight material for quick access
        };

        shipGroup.add(containerMesh);
        currentContainerMeshes.push(containerMesh); // Add to our tracking array

        console.log(`Container ${index + 1} (${size}) at Bay:${bay}, Row:${row}, Tier:${tier} placed at 3D (x,y,z):`,
                    `(${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)})`,
                    `(isBelowDeck: ${containerMesh.userData.isBelowDeck})`);
    });

    console.log("Total containers placed:", currentContainerMeshes.length); // Changed to currentContainerMeshes.length for accuracy
}

// --- Search and Reset Functions ---
function setupSearchListeners() {
    document.getElementById('search-button').addEventListener('click', performSearch);
    document.getElementById('reset-button').addEventListener('click', resetView);
}

function performSearch() {
    const searchId = document.getElementById('search-id').value.trim(); // Get ID and trim whitespace
    const searchBay = document.getElementById('search-bay').value;
    const searchRow = document.getElementById('search-row').value;
    const searchTier = document.getElementById('search-tier').value;
    const searchSize = document.getElementById('search-size').value;

    const bay = searchBay !== '' ? parseInt(searchBay) : null;
    const row = searchRow !== '' ? parseInt(searchRow) : null;
    const tier = searchTier !== '' ? parseInt(searchTier) : null;
    const size = searchSize !== '' ? searchSize : null;

    currentContainerMeshes.forEach(mesh => {
        const userData = mesh.userData;
        let match = true;

        // Check ID if provided
        if (searchId !== '' && userData.id !== searchId) {
            match = false;
        }
        if (bay !== null && userData.bay !== bay) {
            match = false;
        }
        if (row !== null && userData.row !== row) {
            match = false;
        }
        if (tier !== null && userData.tier !== tier) {
            match = false;
        }
        if (size !== null && userData.size !== size) {
            match = false;
        }

        if (match) {
            mesh.material = userData.highlightMaterial;
            mesh.material.opacity = 1.0; // Ensure highlighted is opaque
            mesh.visible = true; // Ensure highlighted is visible
        } else {
            // Make non-matching containers transparent
            mesh.material = mesh.userData.originalMaterial.clone(); // Clone to avoid modifying original shared material
            mesh.material.transparent = true;
            mesh.material.opacity = 0.1; // Make them very dim
        }
    });

    console.log("Search performed:", { id: searchId, bay, row, tier, size });
}

function resetView() {
    currentContainerMeshes.forEach(mesh => {
        mesh.material = mesh.userData.originalMaterial; // Revert to original material instance
        mesh.material.opacity = mesh.userData.originalMaterial.opacity; // Restore original opacity
        mesh.visible = true; // Ensure all are visible
    });

    // Clear all search inputs
    document.getElementById('search-id').value = ''; // Clear new ID input
    document.getElementById('search-bay').value = '';
    document.getElementById('search-row').value = '';
    document.getElementById('search-tier').value = '';
    document.getElementById('search-size').value = '';

    console.log("View reset.");
}


// Initialize the scene when the window loads
window.onload = init;
