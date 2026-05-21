// app.js - Logic khởi tạo giao diện bản đồ với API thực tế (Đã tối ưu ổn định)
document.addEventListener('DOMContentLoaded', () => {
    const mapGrid = document.getElementById('map-grid');
    const warehouseSelect = document.getElementById('warehouse-select');
    const floorSelect = document.getElementById('floor-select');

    // Pathfinding state
    let startNodeId = null;
    let endNodeId = null;
    let isPathfinding = false;
    let currentRobot = null;
    let movingDeviceId = null;     // ID thiết bị đang di chuyển
    let movingDeviceMetadata = {}; // Metadata gốc của thiết bị
    let simulatedPositionMap = {}; // Lưu trữ vị trí giả lập
    let currentNodesMap = {}; // Để tra cứu node.code từ NodeID
    let nodeToLocationMap = {}; // Để tra cứu location từ node_id
    let movingDeviceTypeCode = '';
    let movingDevicePurpose = ''; // Lưu purpose thiết bị được chọn

    // Theo dõi lộ trình thời gian thực
    let activePathForTracking = null;
    let trackedDeviceId = null;
    let lastLoggedNodeIdx = -1;
    let deviceWithCargoMap = {}; // Theo dõi robot nào đang mang hàng

    // Theo dõi trạng thái Task để tránh log lặp lại
    let lastProcessedTasks = {};

    // Global Maps
    let globalTowerMap = {};
    let globalTowerFloorMap = {};
    let globalZoneMap = {};
    let globalZoneTypeMap = {};
    let globalDevicesList = []; // Danh sách thiết bị toàn cục
    let globalDeviceTypeMap = {}; // Danh sách loại thiết bị toàn cục
    let startNodeData = null; // Lưu thông tin node bắt đầu
    let globalNodesMapByQr = {}; // Tra cứu node nhanh bằng QR Code trên toàn kho

    // Login Elements
    const loginModal = document.getElementById('login-modal');
    const loginForm = document.getElementById('login-form');
    const logoutBtn = document.getElementById('logout-btn');
    const userInfo = document.getElementById('user-info');
    const usernameDisplay = document.getElementById('username-display');
    const errorToast = document.getElementById('error-toast');

    let currentZoom = 1;
    let isRendering = false; // Flag chống render chồng chéo

    // --- WebSocket Realtime ---
    const socket = io('http://10.14.82.11:8888/realtime');

    socket.on('connect', () => {
        console.log('✅ [WebSocket] Connected to Realtime Gateway');
    });

    const parseKafkaPayload = (data) => {
        if (!data) return null;
        let payload = data.payload ? (data.payload.payload || data.payload) : data;
        if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch (e) { }
        }
        return payload;
    };

    socket.on('DEVICE_MOVED', (data) => {
        const deviceData = parseKafkaPayload(data);
        // [DEBUG] Theo dõi trạng thái mang hàng gửi từ Gateway
        console.log(`[DEVICE_MOVED] Robot: ${deviceData.code} | PkgStatus: ${deviceData.packageStatus} | Status: ${deviceData.status}`);

        // [FIX] Hỗ trợ cả 'id' (database) và 'no' (simulator). Chuẩn hóa 'code' để đồng nhất với globalDevicesList
        const devId = deviceData.id || deviceData.no;
        const devCode = deviceData.code || deviceData.no || devId;

        if (deviceData && devId) {
            deviceData.id = devId;
            deviceData.code = devCode;

            if (typeof deviceData.metadata === 'string') {
                try { deviceData.metadata = JSON.parse(deviceData.metadata); } catch (e) { }
            }
            // [FIX] Cập nhật ngay vào globalDevicesList để tránh bị ghi đè bởi dữ liệu cũ từ API
            if (Array.isArray(globalDevicesList)) {
                // Tìm kiếm dựa trên cả ID và Code để chắc chắn khớp với dữ liệu từ API (UUID)
                const idx = globalDevicesList.findIndex(d => d.id === devId || (d.code && d.code === devCode));
                if (idx !== -1) {
                    globalDevicesList[idx] = { ...globalDevicesList[idx], ...deviceData };
                } else if (deviceData.code) {
                    globalDevicesList.push(deviceData);
                }
            }
            updateDevicePositions([deviceData]);
        }
    });

    socket.on('LOCATION_CHANGED', (data) => {
        const locationData = parseKafkaPayload(data);
        if (locationData && locationData.id) {
            console.log('📦 Location changed (WS parsed):', locationData.code, locationData.is_occupied);
            updateCargoStatus([locationData]);
        }
    });

    socket.on('TASK_STATUS_CHANGED', (data) => {
        const taskData = parseKafkaPayload(data);
        if (taskData && taskData.id) {
            updateTaskLogs([taskData]);
        }
    });

    socket.on('PATHFINDING_LOG', (data) => {
        const payload = parseKafkaPayload(data);
        if (payload && payload.message) {
            // Chuyển đổi level từ Backend sang class CSS (success, error, system)
            const typeMap = { 'error': 'error', 'success': 'success', 'warn': 'warning' };
            const type = typeMap[payload.level] || 'system';
            const prefix = payload.device_code ? `<b>[${payload.device_code}]</b> ` : "";

            let logDetails = `<span>${payload.details || ""}</span>`;

            // Hiển thị thời gian tìm đường và Task ID
            if (payload.duration_ms !== undefined || payload.task_id) {
                logDetails += `<div style="font-size: 10px; opacity: 0.7; margin-top: 3px; display: flex; justify-content: space-between;">`;
                if (payload.duration_ms !== undefined) logDetails += `<span>⏱️ ${payload.duration_ms}ms</span>`;
                if (payload.task_id) logDetails += `<span>Task: ${payload.task_id.split('-')[0]}...</span>`;
                logDetails += `</div>`;
            }

            // Hiển thị lộ trình chi tiết bằng Tọa độ (A1, B2...) thay vì UUID
            if (payload.steps && Array.isArray(payload.steps) && payload.steps.length > 0) {
                const pathStr = payload.steps.map(s => `${getColumnLabel(s.x - 1)}${s.y}`).join(' → ');
                logDetails += `<div style="margin-top: 5px; padding: 4px; background: rgba(0,0,0,0.04); border-radius: 4px; font-family: 'Courier New', monospace; font-size: 10px; line-height: 1.4; color: #555;">`;
                logDetails += `Lộ trình: ${pathStr}`;
                logDetails += `</div>`;
            }

            addLog(`${prefix}${payload.message}`, type, logDetails);
        }
    });

    socket.on('disconnect', () => {
        console.warn('❌ [WebSocket] Disconnected from Gateway');
    });

    // --- Helpers ---

    const showToast = (message) => {
        errorToast.textContent = message;
        errorToast.classList.add('show');
        setTimeout(() => errorToast.classList.remove('show'), 4000);
    };

    const toggleLoginModal = (show) => {
        loginModal.style.display = show ? 'flex' : 'none';
        if (!show) {
            userInfo.style.display = 'inline';
            logoutBtn.style.display = 'inline';
            usernameDisplay.textContent = 'Admin';
        } else {
            userInfo.style.display = 'none';
            logoutBtn.style.display = 'none';
        }
    };

    const initZoomDrag = () => {
        const zoomBox = document.querySelector('.zoom-controls');
        if (!zoomBox) return;

        const storageKey = 'ui.zoomControls.position';

        const saved = localStorage.getItem(storageKey);
        if (saved) {
            try {
                const pos = JSON.parse(saved);
                if (typeof pos.left === 'number' && typeof pos.top === 'number') {
                    zoomBox.style.left = `${pos.left}px`;
                    zoomBox.style.top = `${pos.top}px`;
                    zoomBox.style.right = 'auto';
                    zoomBox.style.bottom = 'auto';
                }
            } catch (e) {
                localStorage.removeItem(storageKey);
            }
        }

        let dragging = false;
        let startX = 0;
        let startY = 0;
        let originLeft = 0;
        let originTop = 0;

        const getPoint = (evt) => {
            if (evt.touches && evt.touches.length) {
                return { x: evt.touches[0].clientX, y: evt.touches[0].clientY };
            }
            return { x: evt.clientX, y: evt.clientY };
        };

        const onStart = (evt) => {
            if (evt.type === 'mousedown' && evt.button !== 0) return;

            const target = evt.target;
            if (target && target.classList.contains('zoom-btn')) return;

            const point = getPoint(evt);
            const rect = zoomBox.getBoundingClientRect();
            dragging = true;
            startX = point.x;
            startY = point.y;
            originLeft = rect.left;
            originTop = rect.top;
            zoomBox.classList.add('dragging');
            evt.preventDefault();
        };

        const onMove = (evt) => {
            if (!dragging) return;
            const point = getPoint(evt);
            const dx = point.x - startX;
            const dy = point.y - startY;

            zoomBox.style.left = `${originLeft + dx}px`;
            zoomBox.style.top = `${originTop + dy}px`;
            zoomBox.style.right = 'auto';
            zoomBox.style.bottom = 'auto';
        };

        const onEnd = () => {
            if (!dragging) return;
            dragging = false;
            zoomBox.classList.remove('dragging');

            const rect = zoomBox.getBoundingClientRect();
            localStorage.setItem(storageKey, JSON.stringify({ left: rect.left, top: rect.top }));
        };

        zoomBox.addEventListener('mousedown', onStart);
        zoomBox.addEventListener('touchstart', onStart, { passive: false });
        window.addEventListener('mousemove', onMove);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('mouseup', onEnd);
        window.addEventListener('touchend', onEnd);
    };

    initZoomDrag();

    MapService.onUnauthorized = () => {
        toggleLoginModal(true);
    };

    const getColumnLabel = (index) => {
        let label = '';
        let tempIndex = index;
        while (tempIndex >= 0) {
            label = String.fromCharCode((tempIndex % 26) + 65) + label;
            tempIndex = Math.floor(tempIndex / 26) - 1;
        }
        return label;
    };

    /**
     * Trả về màu sắc ĐỘC NHẤT cho mỗi thực thể (Zone, SubZone, Tower, ...)
     * Đảm bảo phân tách rõ rệt các khu vực quan trọng
     */
    const getEntityColor = (entity, type = 'zone', baseHue = null) => {
        if (!entity || !entity.id) return { bg: 'transparent', border: 'rgba(0,0,0,0.05)' };

        // 1. Hash ID
        let hash = 0;
        const name = (entity.name || '').toUpperCase();
        const code = (entity.code || '').toUpperCase();
        const str = entity.id + name + code;
        for (let i = 0; i < str.length; i++) {
            hash = (hash << 5) - hash + str.charCodeAt(i);
            hash |= 0;
        }

        // 2. Sử dụng Golden Ratio để phân bổ sắc độ (Hue)
        const phi = 0.618033988749895;
        let h = baseHue !== null ? (baseHue / 360) : ((Math.abs(hash) * phi) % 1);
        const hue = baseHue !== null ? baseHue : Math.floor(h * 360);

        // 3. Quy chuẩn màu sắc hiện đại cho Warehouse
        let sat, light, alpha;

        if (type === 'zone') {
            // Zone STORAGE sẽ có viền đậm, Zone khác ẩn đi
            sat = 70;
            light = 50;
            alpha = 1.0;
        } else if (type === 'tower') {
            sat = 40;
            light = 40;
            alpha = 0.15;
        } else {
            sat = 50;
            light = 70;
            alpha = 0.3;
        }

        return {
            bg: `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`,
            border: `hsla(${hue}, ${sat + 10}%, ${light - 20}%, 0.8)`,
            hue: hue
        };
    };

    // Hàm bao cũ để không làm gãy code hiện tại
    const getZoneColor = (zone) => getEntityColor(zone, 'zone');



    /**
     * Bóc tách tọa độ x, y, z từ qrcode định dạng: [Z]X[XXXX]Y[YYYY]
     * Ví dụ: 1X0009Y0009 -> x=9, y=9, z=1
     */
    const parseQrCodeCoords = (qrcode) => {
        if (!qrcode || typeof qrcode !== 'string') return null;

        // Tìm trực tiếp trong danh sách node toàn cục bằng qrcode (Không phụ thuộc x,y,z cố định)
        if (typeof globalNodesMapByQr !== 'undefined') {
            const node = globalNodesMapByQr[qrcode];
            if (node && node.x !== undefined && node.y !== undefined) {
                return {
                    x: node.x,
                    y: node.y,
                    z: node.z !== undefined ? node.z : 1
                };
            }
        }
        return null;
    };

    // --- API Logic ---

    const init = async () => {
        const token = localStorage.getItem('access_token');
        if (!token) {
            toggleLoginModal(true);
            return;
        }

        try {
            toggleLoginModal(false);
            const response = await MapService.fetchWarehouses();
            if (response && response.elements) {
                // Giữ lại option đầu tiên
                warehouseSelect.innerHTML = '<option value="">Chọn kho...</option>';
                response.elements.forEach(wh => {
                    const opt = document.createElement('option');
                    opt.value = wh.id;
                    opt.textContent = `${wh.name} (${wh.code})`;
                    warehouseSelect.appendChild(opt);
                });
            }
        } catch (error) {
            if (error.message === '401') return;
            showToast("Không thể tải danh sách kho.");
        }
    };

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;

        try {
            await MapService.login(username, password);
            init();
        } catch (error) {
            showToast(error.message || "Đăng nhập thất bại.");
        }
    });

    logoutBtn.addEventListener('click', () => {
        MapService.logout();
        warehouseSelect.innerHTML = '<option value="">Chọn kho...</option>';
        floorSelect.innerHTML = '<option value="">Chọn tầng...</option>';
        mapGrid.innerHTML = '';
    });

    const reloadRamBtn = document.getElementById('reload-ram-btn');
    if (reloadRamBtn) {
        reloadRamBtn.addEventListener('click', async () => {
            const whId = warehouseSelect.value;
            if (!whId) {
                showToast("Vui lòng chọn kho trước khi nạp lại RAM.");
                return;
            }

            try {
                reloadRamBtn.disabled = true;
                const originalText = reloadRamBtn.textContent;
                reloadRamBtn.textContent = "Đang nạp...";

                await MapService.reloadMapState(whId);

                showToast("Đã gửi lệnh nạp lại bản đồ vào RAM thành công.");
                // Sau khi nạp lại RAM, ta nên render lại lưới để cập nhật trạng thái mới nhất
                renderGrid(true);
            } catch (error) {
                showToast("Lỗi khi nạp lại RAM: " + error.message);
            } finally {
                reloadRamBtn.disabled = false;
                reloadRamBtn.textContent = "Nạp lại RAM";
            }
        });
    }

    warehouseSelect.addEventListener('change', async () => {
        const whId = warehouseSelect.value;
        floorSelect.innerHTML = '<option value="">Chọn tầng...</option>';
        mapGrid.innerHTML = '';
        globalNodesMapByQr = {}; // Reset bản đồ QR
        if (!whId) return;

        try {
            const response = await MapService.fetchFloors(whId);
            if (response && response.elements) {
                response.elements.forEach(floor => {
                    const opt = document.createElement('option');
                    opt.value = floor.id;
                    opt.textContent = floor.name;
                    floorSelect.appendChild(opt);
                });

                // Fetch nodes cho TẤT CẢ các tầng để lập bản đồ QR toàn cục trong kho
                const floorNodesPromises = response.elements.map(floor =>
                    MapService.fetchNodes(whId, floor.id).then(res => {
                        const nodes = res ? (res.elements || res.data || []) : [];
                        nodes.forEach(node => {
                            const floorText = floor.name || "";
                            const floorMatch = floorText.match(/\d+/);
                            const floorZ = floorMatch ? parseInt(floorMatch[0]) : 1;

                            node.z = floorZ;
                            node.warehouse_floor_id = floor.id;

                            if (node.qrcode) {
                                globalNodesMapByQr[node.qrcode] = node;
                            }
                            if (node.qr_code) {
                                globalNodesMapByQr[node.qr_code] = node;
                            }
                        });
                    }).catch(e => console.error(`Error loading nodes for floor ${floor.id}:`, e))
                );
                Promise.all(floorNodesPromises).then(() => {
                    console.log(`[Nodes Loaded] Tổng số nodes nạp theo QR: ${Object.keys(globalNodesMapByQr).length}`);
                });
            }
        } catch (error) {
            if (error.message === '401') return;
            showToast("Không thể tải danh sách tầng.");
        }
    });

    floorSelect.addEventListener('change', () => {
        isMapStaticRendered = false; // Reset khi đổi tầng
        renderGrid();
    });

    let isMapStaticRendered = false;
    let cachedDeviceElements = {}; // Lưu trữ tham chiếu tới element của device

    // Hàm render lưới và các đối tượng (Zone, Node) - TỐI ƯU HÓA ỔN ĐỊNH
    const renderGrid = async (isSilent = false) => {
        const whId = warehouseSelect.value;
        const floorId = floorSelect.value;
        if (!whId || !floorId || isRendering) return;

        isRendering = true;

        let overlay;
        if (!isSilent && !isMapStaticRendered) {
            overlay = document.createElement('div');
            overlay.id = 'render-overlay';
            overlay.style = "position:absolute; top:0; left:0; width:100%; height:100%; background:rgba(255,255,255,0.6); display:flex; align-items:center; justify-content:center; z-index:99; border-radius:8px;";
            overlay.innerHTML = '<div style="background:white; padding:10px 20px; border-radius:20px; box-shadow:0 2px 10px rgba(0,0,0,0.1)">Đang vẽ sơ đồ...</div>';
            const wrapper = document.querySelector('.map-wrapper');
            if (wrapper) wrapper.appendChild(overlay);
        }

        try {
            const whDetail = await MapService.fetchWarehouseDetail(whId);
            if (!whDetail || !whDetail.elements) throw new Error("No WH detail");
            const { column: columns, row: rows } = whDetail.elements;

            const [nodesRes, zonesRes, zoneTypesRes, deviceTypesRes, devicesRes, towersRes, towerFloorsRes] = await Promise.all([
                MapService.fetchNodes(whId, floorId),
                MapService.fetchZones(whId, floorId),
                MapService.fetchZoneTypes(),
                MapService.fetchDeviceTypes(),
                MapService.fetchDevices(whId),
                MapService.fetchTowers(whId),
                MapService.fetchTowerFloors(whId)
            ]);

            const nodes = nodesRes ? (nodesRes.elements || nodesRes.data || []) : [];
            const zones = zonesRes ? (zonesRes.elements || zonesRes.data || []) : [];
            const towers = towersRes ? (towersRes.elements || towersRes.data || []) : [];
            const towerFloors = towerFloorsRes ? (towerFloorsRes.elements || towerFloorsRes.data || []) : [];
            const zoneTypesList = zoneTypesRes ? (zoneTypesRes.elements || zoneTypesRes.data || []) : [];
            const deviceTypesList = deviceTypesRes ? (deviceTypesRes.elements || deviceTypesRes.data || []) : [];
            const devicesList = devicesRes ? (devicesRes.elements || devicesRes.data || []) : [];
            globalDevicesList = devicesList;

            const floorText = floorSelect.options[floorSelect.selectedIndex]?.text || "";
            const floorMatch = floorText.match(/\d+/);
            const currentFloorZ = floorMatch ? parseInt(floorMatch[0]) : 1;

            globalDeviceTypeMap = {};
            deviceTypesList.forEach(dt => { globalDeviceTypeMap[dt.id] = dt; });

            let locations = [];
            let p = 1;
            while (p <= 10) {
                const res = await MapService.fetchLocations(whId, p);
                const elements = res ? (res.elements || res.data || []) : [];
                // Lọc kỹ: Chỉ lấy location có Z khớp với tầng hiện tại
                const floorElements = elements.filter(loc => loc.z === currentFloorZ);
                locations = locations.concat(floorElements);
                if (elements.length < 500) break;
                p++;
            }

            globalZoneTypeMap = {};
            zoneTypesList.forEach(zt => { globalZoneTypeMap[zt.id] = zt; });

            const deviceTypeMap = globalDeviceTypeMap;

            nodeToLocationMap = {}; // Reset shared map
            const coordToLocationMap = {};
            locations.forEach(loc => {
                if (loc.node_id) nodeToLocationMap[loc.node_id] = loc;
                if (loc.x !== null && loc.y !== null) {
                    coordToLocationMap[`${loc.x}:${loc.y}`] = loc;
                }
            });

            const fragment = document.createDocumentFragment();
            // Lưới 1-based: Cột 1 và Dòng 1 cho nhãn
            // Lưới 1-based: Dùng CSS variable để sticky headers hoạt động chính xác
            mapGrid.style.gridTemplateColumns = `var(--grid-size) repeat(${columns}, var(--grid-size))`;
            mapGrid.style.gridTemplateRows = `var(--grid-size) repeat(${rows}, var(--grid-size))`;

            const cornerDiv = document.createElement('div');
            cornerDiv.className = 'grid-cell corner-cell';
            cornerDiv.style.gridArea = '1 / 1';
            fragment.appendChild(cornerDiv);

            for (let c = 1; c <= columns; c++) {
                const xLabel = document.createElement('div');
                xLabel.className = 'grid-cell x-axis-label';
                xLabel.textContent = getColumnLabel(c - 1);
                xLabel.style.gridArea = `1 / ${c + 1}`;
                fragment.appendChild(xLabel);
            }

            for (let r = 1; r <= rows; r++) {
                const yLabel = document.createElement('div');
                yLabel.className = 'grid-cell y-axis-label';
                yLabel.textContent = r;
                yLabel.style.gridArea = `${r + 1} / 1`;
                fragment.appendChild(yLabel);

                for (let c = 1; c <= columns; c++) {
                    const cell = document.createElement('div');
                    cell.className = 'grid-cell grid-dot';
                    cell.style.gridArea = `${r + 1} / ${c + 1}`;
                    cell.setAttribute('data-x', c);
                    cell.setAttribute('data-y', r);
                    fragment.appendChild(cell);
                }
            }

            globalZoneMap = {};
            zones.forEach(z => { globalZoneMap[z.id] = z; });

            globalTowerMap = {};
            towers.forEach(t => { globalTowerMap[t.id] = t; });

            globalTowerFloorMap = {};
            towerFloors.forEach(tf => { globalTowerFloorMap[tf.id] = tf; });

            // 4. Pre-calculate Zone Hues for distinct colors (Tối ưu màu sắc khác biệt)
            const zoneHueMap = new Map();
            const sortedZones = [...zones].sort((a, b) => (a.code || '').localeCompare(b.code || ''));
            sortedZones.forEach((z, i) => {
                // Sử dụng Golden Angle (xấp xỉ 137.5 độ) để phân bổ màu sắc tối ưu trên vòng tròn màu
                const hue = (i * 137.5) % 360;
                zoneHueMap.set(z.id, hue);
            });

            // Track nodes by coordinates for neighbor lookups
            const coordToNodeMap = {};
            nodes.forEach(node => {
                if (node.x !== undefined && node.y !== undefined) {
                    coordToNodeMap[`${node.x}:${node.y}`] = node;
                }
            });

            // Cập nhật bảng chú thích (Legend)
            updateIconLegend(); // Chú thích biểu tượng
            updateZoneLegend(zones, towers, zoneHueMap); // Chú thích màu sắc khu vực

            currentNodesMap = {};

            nodes.forEach(node => {
                if (node.x !== undefined && node.y !== undefined) {
                    node.z = currentFloorZ;
                    node.warehouse_floor_id = floorId;
                    currentNodesMap[node.id] = node;

                    // Đồng bộ thêm vào global QR lookup
                    if (node.qrcode) globalNodesMapByQr[node.qrcode] = node;
                    if (node.qr_code) globalNodesMapByQr[node.qr_code] = node;

                    const row = node.y + 1;
                    const col = node.x + 1;
                    const gridPos = `${row} / ${col} / ${row + 1} / ${col + 1}`;

                    const nodeHighlight = document.createElement('div');
                    nodeHighlight.className = 'map-zone-overlay';
                    nodeHighlight.style.gridArea = gridPos;
                    nodeHighlight.setAttribute('data-node-id', node.id);

                    const zone = node.zone_id ? globalZoneMap[node.zone_id] : null;
                    const towerFloor = node.tower_floor_id ? globalTowerFloorMap[node.tower_floor_id] : null;
                    const tower = (towerFloor && towerFloor.tower_id) ? globalTowerMap[towerFloor.tower_id] : null;

                    let location = nodeToLocationMap[node.id] || coordToLocationMap[`${node.x}:${node.y}`];

                    const towerInfo = tower ? `\nTower: ${tower.name} (${tower.code})` : '';
                    const towerFloorInfo = towerFloor ? `\nTower Floor: ${towerFloor.name} (${towerFloor.code})` : '';
                    const zoneInfo = zone ? `\nZone: ${zone.name} (${zone.code})` : '';
                    const qrInfo = node.qrcode ? `\nQR Code: ${node.qrcode}` : '';

                    let occupiedInfo = location ? `\nLocation: ${location.code}\nTrạng thái: ${location.is_occupied ? 'CÓ HÀNG' : 'TRỐNG'}` : '\nChưa có location';

                    nodeHighlight.title = `${node.name} (${node.code})${towerInfo}${towerFloorInfo}${zoneInfo}${qrInfo}${occupiedInfo}\nTọa độ: ${getColumnLabel(node.x - 1)}${node.y}`;
                    nodeHighlight.style.pointerEvents = 'auto';
                    nodeHighlight.style.cursor = 'pointer';
                    nodeHighlight.style.position = 'relative';

                    // Lấy ZoneType
                    const zoneType = (zone && zone.zone_type_id && globalZoneTypeMap[zone.zone_type_id]) ? globalZoneTypeMap[zone.zone_type_id].code : '';
                    const isStorage = zoneType === 'STORAGE';

                    if (isStorage) {
                        const zoneHue = zone ? zoneHueMap.get(zone.id) : null;
                        const zoneStyle = getEntityColor(zone, 'zone', zoneHue);
                        const zid = zone.id;

                        // Chỉ dùng viền màu bao quanh, không bôi màu nền
                        nodeHighlight.style.backgroundColor = 'transparent';
                        nodeHighlight.classList.add('is-storage-node');
                        nodeHighlight.style.borderRadius = '0';

                        // Logic vẽ viền bao quanh cụm node STORAGE khớp chính xác với hình dạng
                        const nx = node.x, ny = node.y;
                        const bColor = zoneStyle.border;
                        const bWidth = '3px';

                        const hasT = coordToNodeMap[`${nx}:${ny - 1}`]?.zone_id === zid;
                        const hasB = coordToNodeMap[`${nx}:${ny + 1}`]?.zone_id === zid;
                        const hasL = coordToNodeMap[`${nx - 1}:${ny}`]?.zone_id === zid;
                        const hasR = coordToNodeMap[`${nx + 1}:${ny}`]?.zone_id === zid;

                        if (!hasT) nodeHighlight.style.borderTop = `${bWidth} solid ${bColor}`;
                        if (!hasB) nodeHighlight.style.borderBottom = `${bWidth} solid ${bColor}`;
                        if (!hasL) nodeHighlight.style.borderLeft = `${bWidth} solid ${bColor}`;
                        if (!hasR) nodeHighlight.style.borderRight = `${bWidth} solid ${bColor}`;

                        // Bo góc mượt mà cho các góc ngoài
                        const radius = '6px';
                        if (!hasT && !hasL) nodeHighlight.style.borderTopLeftRadius = radius;
                        if (!hasT && !hasR) nodeHighlight.style.borderTopRightRadius = radius;
                        if (!hasB && !hasL) nodeHighlight.style.borderBottomLeftRadius = radius;
                        if (!hasB && !hasR) nodeHighlight.style.borderBottomRightRadius = radius;
                    } else {
                        // Khu vực không phải STORAGE: Không màu, không viền
                        nodeHighlight.style.backgroundColor = 'transparent';
                        nodeHighlight.classList.add('is-non-storage');
                    }

                    // 3. Tower Border
                    // IMPORTANT: Do NOT draw tower border per-node.
                    // Doing so makes shared edges double-thick and introduces strong colored separators.
                    // For the requested UX, STORAGE nodes should keep only the subtle black separators.
                    nodeHighlight.style.boxShadow = 'none';

                    // Thêm label tên node và sub-zone (hiển thị khi hover)
                    const nodeNameLabel = document.createElement('div');
                    nodeNameLabel.className = 'node-map-label';
                    const nodeShortCode = (node.code || '').replace(/^NODE-/, '');
                    nodeNameLabel.textContent = nodeShortCode;
                    nodeHighlight.appendChild(nodeNameLabel);

                    fragment.appendChild(nodeHighlight);
                    isMapStaticRendered = true; // Đánh dấu đã vẽ xong lưới tĩnh

                    const mask = node.neighbor_mask || (node.directions ? node.directions.join('') : '');
                    if (mask) {
                        const cleanMask = mask.replace(/[^0-9]/g, '');
                        const createArrow = (cls, sym) => {
                            const arrow = document.createElement('div');
                            arrow.className = `direction-arrow ${cls}`;
                            arrow.innerText = sym;
                            nodeHighlight.appendChild(arrow);
                        };
                        if (cleanMask[0] === '1') createArrow('arrow-up', '↑');
                        if (cleanMask[1] === '1') createArrow('arrow-right', '→');
                        if (cleanMask[2] === '1') createArrow('arrow-down', '↓');
                        if (cleanMask[3] === '1') createArrow('arrow-left', '←');
                        if (cleanMask[4] === '1') createArrow('arrow-elev-up', '⤴');
                        if (cleanMask[5] === '1') createArrow('arrow-elev-down', '⤵');

                        const dirLabels = ['Tiến', 'Phải', 'Lùi', 'Trái', 'UP', 'DOWN'];
                        const activeDirs = [];
                        for (let i = 0; i < 6; i++) if (cleanMask[i] === '1') activeDirs.push(dirLabels[i]);
                        if (activeDirs.length > 0) nodeHighlight.title += `\nHướng: ${activeDirs.join(', ')}`;
                    }

                    nodeHighlight.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (isPathfinding) return;
                        if (!startNodeId) {
                            startNodeId = node.id;
                            startNodeData = node; // Lưu lại data node bắt đầu
                            nodeHighlight.classList.add('node-selected-start');
                            showToast("Đã chọn điểm bắt đầu.");
                        } else if (!endNodeId && node.id !== startNodeId) {
                            endNodeId = node.id;
                            nodeHighlight.classList.add('node-selected-end');
                            runPathfinding(whId, startNodeId, endNodeId);
                        }
                    });

                    if (node.id === startNodeId) nodeHighlight.classList.add('node-selected-start');
                    if (node.id === endNodeId) nodeHighlight.classList.add('node-selected-end');

                    // Zone icons based on zone_type (special areas)
                    // Applies to any node whose zone has these zone_type codes.
                    const zoneTypeCode = (zone && zone.zone_type_id && globalZoneTypeMap[zone.zone_type_id])
                        ? String(globalZoneTypeMap[zone.zone_type_id].code || '')
                        : '';
                    const normalizedZoneType = zoneTypeCode.toUpperCase();
                    const normalizedZoneCode = (zone && zone.code) ? String(zone.code).toUpperCase() : '';
                    const normalizedZoneName = (zone && zone.name) ? String(zone.name).toUpperCase() : '';

                    let zoneIconClass = '';
                    if (normalizedZoneType.includes('CHARGING') || normalizedZoneCode.includes('CHARGING') || normalizedZoneName.includes('CHARGING')) {
                        zoneIconClass = 'charging-icon';
                    } else if (normalizedZoneType.includes('PARKING') || normalizedZoneCode.includes('PARKING') || normalizedZoneName.includes('PARKING')) {
                        zoneIconClass = 'parking-icon';
                    } else if (normalizedZoneType.includes('WAITING') || normalizedZoneType.includes('WAIT')) {
                        zoneIconClass = 'waiting-icon';
                    } else if (normalizedZoneType.includes('LIFTER')) {
                        zoneIconClass = 'lifter-icon';
                    } else if (normalizedZoneType.includes('INBOUND')) {
                        zoneIconClass = 'import-icon';
                    } else if (normalizedZoneType.includes('OUTBOUND')) {
                        zoneIconClass = 'export-icon';
                    }

                    if (zoneIconClass) {
                        const icon = document.createElement('div');
                        icon.className = `zone-icon ${zoneIconClass} small-icon`;
                        icon.style.gridArea = gridPos;
                        fragment.appendChild(icon);
                    }

                    // Hiển thị icon hàng hóa (Cargo) nếu ô này có hàng
                    // nodeToLocationMap đã được populate từ danh sách locations phía trên
                    if (location && (location.is_occupied === true || location.is_occupied === 1 || String(location.is_occupied).toLowerCase() === 'true')) {
                        const icon = document.createElement('div');
                        icon.className = 'zone-icon cargo-icon';
                        icon.style.gridArea = gridPos;
                        icon.setAttribute('data-location-id', location.id || location._id);
                        fragment.appendChild(icon);
                    }

                }
            });

            // 5. Finalize Grid
            mapGrid.innerHTML = '';
            cachedDeviceElements = {}; // Reset cache when building new grid

            const pathSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            pathSvg.id = 'path-svg';
            pathSvg.setAttribute("class", "path-svg");
            pathSvg.style.gridArea = '1 / 1 / -1 / -1';
            mapGrid.appendChild(pathSvg);

            mapGrid.appendChild(fragment);

            // Render Devices using centralized logic
            updateDevicePositions(devicesList, true);

            // Re-sync cached elements hoàn tất
            cachedDeviceElements = {};
            mapGrid.querySelectorAll('.device-icon').forEach(el => {
                const id = el.getAttribute('data-id');
                if (id) cachedDeviceElements[id] = el;
            });

        } catch (error) {
            if (error.message !== '401') showToast("Lỗi khi tải dữ liệu bản đồ.");
        } finally {
            isRendering = false;
            if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }
    };



    const applyZoom = () => {
        const gridSize = 40 * currentZoom;
        mapGrid.style.setProperty('--grid-size', gridSize + 'px');

        // Cập nhật lại vị trí tất cả device icons ngay lập tức khi zoom thay đổi
        // để tránh hiện tượng icon bị lệch khỏi grid
        if (typeof updateDevicePositions === 'function') {
            updateDevicePositions(globalDevicesList, true);
        }
    };

    document.getElementById('zoom-in').addEventListener('click', () => {
        if (currentZoom < 3) { // Giới hạn zoom nhỏ hơn khi đổi sang layout zoom để tránh đơ
            currentZoom += 0.2; applyZoom();
        }
    });

    document.getElementById('zoom-out').addEventListener('click', () => {
        if (currentZoom > 0.5) {
            currentZoom -= 0.2; applyZoom();
        }
    });

    document.getElementById('reload-ram-btn').addEventListener('click', async () => {
        const whId = warehouseSelect.value;
        if (!whId) { showToast("Vui lòng chọn kho trước."); return; }
        try {
            await MapService.reloadMap(whId);
            addLog(`✅ Nạp lại RAM thành công`, "success");
            showToast("Đã nạp lại dữ liệu bản đồ thành công!");
        } catch (e) { showToast("Lỗi nạp lại RAM."); }
    });

    /**
     * Cập nhật bảng chú thích BIỂU TƯỢNG (Phần trên)
     */
    const updateIconLegend = () => {
        const container = document.getElementById('legend-icons-body');
        if (!container) return;

        container.innerHTML = '';

        const iconLegends = [
            { class: 'shuttle-device', name: 'Robot Shuttle', isDevice: true },
            { class: 'lifter-device', name: 'Thang máy (Lifter)', isDevice: true },
            { class: 'charging-icon', name: 'Trạm sạc', isZone: true },
            { class: 'parking-icon', name: 'Khu vực đỗ (Parking)', isZone: true },
            { class: 'waiting-icon', name: 'Khu vực chờ', isZone: true },
            { class: 'lifter-icon', name: 'Lifter Zone', isZone: true },
            { class: 'import-icon', name: 'Nhập hàng (Inbound)', isZone: true },
            { class: 'export-icon', name: 'Xuất hàng (Outbound)', isZone: true },
            { class: 'cargo-icon', name: 'Ô có hàng (Box)', isCargo: true }
        ];

        iconLegends.forEach(item => {
            const legendItem = document.createElement('div');
            legendItem.className = 'legend-item';

            const iconBox = document.createElement('div');
            iconBox.className = 'legend-color-box';
            iconBox.style.display = 'flex';
            iconBox.style.alignItems = 'center';
            iconBox.style.justifyContent = 'center';
            iconBox.style.background = '#f8faff';

            const iconInner = document.createElement('div');
            if (item.isDevice) {
                iconInner.className = `legend-device-icon ${item.class}`;
            } else {
                iconInner.className = `zone-icon ${item.class}`;
            }
            // Reset style để khớp với legend box
            iconInner.style.position = 'static';
            iconInner.style.margin = '0';
            iconInner.style.pointerEvents = 'none';
            iconInner.style.width = '31px';
            iconInner.style.height = '31px';
            iconInner.style.backgroundSize = '120%'; // Đạm bảo icon to rõ tối đa trong khung 32px

            iconBox.appendChild(iconInner);

            const nameEl = document.createElement('div');
            nameEl.className = 'legend-name';
            nameEl.textContent = item.name;

            legendItem.appendChild(iconBox);
            legendItem.appendChild(nameEl);
            container.appendChild(legendItem);
        });
    };

    const updateZoneLegend = (zones, towers = [], zoneHueMap = null) => {
        const legendBody = document.getElementById('legend-colors-body');
        if (!legendBody) return;

        if ((!zones || zones.length === 0) && (!towers || towers.length === 0)) {
            legendBody.innerHTML = '<div class="legend-item-placeholder">Không có khu vực nào...</div>';
            return;
        }

        legendBody.innerHTML = '';

        // 1. Legend cho Tower (Border)
        if (towers && towers.length > 0) {
            towers.forEach(tower => {
                const { border } = getEntityColor(tower, 'tower');
                const item = document.createElement('div');
                item.className = 'legend-item';
                item.innerHTML = `
                    <div class="legend-color-box" style="background: transparent; border: 2.5px solid ${border}; border-radius: 4px;"></div>
                    <div class="legend-code" style="color: ${border}; text-decoration: underline;">TWR: ${tower.code}</div>
                `;
                legendBody.appendChild(item);
            });
        }

        // 2. Legend cho Zone (Chỉ hiển thị STORAGE)
        if (zones && zones.length > 0) {
            zones
                .filter(z => z.zone_type_id === '8caa4e32-3da3-4780-abbe-0b2e38eb1bea')
                .forEach(zone => {
                    const hue = zoneHueMap ? zoneHueMap.get(zone.id) : null;
                    const { bg, border } = getEntityColor(zone, 'zone', hue);
                    const item = document.createElement('div');
                    item.className = 'legend-item';
                    item.innerHTML = `
                        <div class="legend-color-box" style="background-color: ${bg}; border: 1.5px solid ${border}"></div>
                        <div class="legend-code">ZONE: ${zone.name || zone.code}</div>
                    `;
                    legendBody.appendChild(item);
                });
        }
    };

    const addLog = (message, type = 'system', details = '') => {
        const logBody = document.getElementById('log-body');
        if (!logBody) return;
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        const timeStr = new Date().toLocaleTimeString('vi-VN');
        entry.innerHTML = `<span class="time">${timeStr}</span> ${message}${details ? `<div class="result-box">${details}</div>` : ''}`;
        logBody.appendChild(entry);
        logBody.scrollTop = logBody.scrollHeight;
    };

    document.getElementById('clear-log-mini')?.addEventListener('click', () => {
        const logBody = document.getElementById('log-body');
        if (logBody) logBody.innerHTML = '<div class="log-entry system">Sẵn sàng chọn điểm...</div>';
    });

    /**
     * Ghi Log cho Task Activity (Hỗ trợ phân luồng Inbound/Outbound)
     */
    const addTaskLog = (message, type = 'info') => {
        const body = document.getElementById('task-log-body');
        if (!body) return;

        const row = document.createElement('tr');
        row.className = `task-log-row ${type}`;

        const now = new Date();
        const dateStr = now.getDate().toString().padStart(2, '0') + '/' +
            (now.getMonth() + 1).toString().padStart(2, '0') + '/' +
            now.getFullYear();
        const timeStr = now.getHours().toString().padStart(2, '0') + ':' +
            now.getMinutes().toString().padStart(2, '0') + ':' +
            now.getSeconds().toString().padStart(2, '0');

        row.innerHTML = `<td class="col-date">${dateStr}</td><td class="col-time">${timeStr}</td><td>${message}</td>`;
        body.appendChild(row);

        // Tự động cuộn xuống để xem log mới nhất (Giống pathfinding log)
        const container = body.closest('.scrollable');
        if (container) {
            container.scrollTop = container.scrollHeight;
        }

        while (body.children.length > 120) body.removeChild(body.firstChild);
    };

    document.getElementById('clear-task-log')?.addEventListener('click', () => {
        const body = document.getElementById('task-log-body');
        if (body) body.innerHTML = '<tr class="task-log-row system"><td class="col-date">--/--/----</td><td class="col-time">--:--:--</td><td>Log task đã được xóa.</td></tr>';
        lastProcessedTasks = {};
    });

    const resetPathfinding = () => {
        startNodeId = null; startNodeData = null; endNodeId = null; movingDeviceId = null; movingDevicePurpose = '';
        if (currentRobot && currentRobot.parentNode) { currentRobot.parentNode.removeChild(currentRobot); currentRobot = null; }
        document.querySelectorAll('.node-selected-start, .node-selected-end, .path-step-highlight').forEach(el => el.classList.remove('node-selected-start', 'node-selected-end', 'path-step-highlight'));
        const pathSvg = document.getElementById('path-svg');
        if (pathSvg) pathSvg.innerHTML = '';
        const clearBtn = document.getElementById('clear-path-btn');
        if (clearBtn) clearBtn.style.display = 'none';
        renderGrid();
    };

    const animateRobot = async (path) => {
        const pathSvg = document.getElementById('path-svg');
        const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
        polyline.setAttribute("class", "path-line");
        pathSvg.appendChild(polyline);
        let points = "";
        let stepCount = 0;
        for (const step of path) {
            const floorText = floorSelect.options[floorSelect.selectedIndex]?.text || "";
            const floorMatch = floorText.match(/\d+/);
            const floorNum = floorMatch ? floorMatch[0] : "";
            const gridSize = 40 * currentZoom;
            const cx = step.X * gridSize + (gridSize / 2);
            const cy = step.Y * gridSize + (gridSize / 2);

            const nodeInfo = currentNodesMap[step.NodeID];
            const displayId = nodeInfo ? (nodeInfo.code || '').replace(/^NODE-/, '') : step.NodeID;

            addLog(`   [${stepCount}] <b>${displayId}</b> | Tọa độ: (${step.X}, ${step.Y})`, "path");
            points += `${cx},${cy} `;
            polyline.setAttribute("points", points);
            if (currentRobot) { currentRobot.style.gridArea = `${step.Y + 1} / ${step.X + 1}`; }
            stepCount++;
            await new Promise(r => setTimeout(r, 600));
        }
    };

    const runPathfinding = async (whId, startId, endId) => {
        isPathfinding = true;
        addLog(`🚀 Đang tính toán lộ trình tối ưu...`);
        const pathSvg = document.getElementById('path-svg');
        if (pathSvg) pathSvg.innerHTML = '';
        try {
            let deviceLabel = "";
            let targetDeviceIcon = null;
            if (movingDeviceId) {
                targetDeviceIcon = document.querySelector(`.device-icon[data-id="${movingDeviceId}"]`);
                if (targetDeviceIcon) {
                    deviceLabel = targetDeviceIcon.getAttribute('data-label') || "";
                    targetDeviceIcon.style.opacity = '0';
                }
            }

            if (movingDeviceTypeCode === 'LIFTER') {
                const startNode = startNodeData;
                const endNode = currentNodesMap[endId];
                if (startNode && endNode) {
                    if (startNode.x !== endNode.x || startNode.y !== endNode.y) {
                        throw new Error("Lifter chỉ có thể di chuyển lên hoặc xuống tại vị trí tọa độ x,y đó thôi!");
                    }
                    addLog(`🛗 [Lifter] Đang thực hiện di chuyển theo trục thẳng đứng...`, "system");
                }
            }

            const res = await MapService.fetchPath(whId, startId, endId, movingDevicePurpose);
            if (!res || !res.path) throw new Error("Không tìm được đường!");
            const path = res.path;

            const details = `
                - Số bước: ${path.length}<br/>
                - Tổng chi phí: ${res.total_cost}<br/>
                - Nodes đã duyệt: ${res.nodes_explored}<br/>
                - Thời gian tính toán: ${res.duration}<br/>
                - Snapshot Version: ${res.version}
            `;
            addLog("✅ TÌM ĐƯỜNG THÀNH CÔNG", "success", details);
            const floorText = floorSelect.options[floorSelect.selectedIndex]?.text || "";
            const floorMatch = floorText.match(/\d+/);
            const floorNum = floorMatch ? floorMatch[0] : "";
            const startLabel = `${floorNum}${getColumnLabel(path[0].X)}${path[0].Y + 1}`;
            const endLabel = `${floorNum}${getColumnLabel(path[path.length - 1].X)}${path[path.length - 1].Y + 1}`;
            addLog(`🚀 Đường đi từ <b>${startLabel}</b> đến <b>${endLabel}</b>:`, "system");

            // Thiết lập theo dõi lộ trình thời gian thực
            activePathForTracking = path;
            trackedDeviceId = movingDeviceId;
            lastLoggedNodeIdx = -1; // Chưa log bước nào

            path.forEach(node => {
                const cells = document.querySelectorAll('.map-zone-overlay');
                cells.forEach(c => {
                    if (c.title && (c.title.includes(`(${path[0].X}, ${path[0].Y})`) || c.title.includes(node.NodeID))) {
                        c.classList.add('path-step-highlight');
                    }
                });
            });

            if (currentRobot && currentRobot.parentNode) currentRobot.parentNode.removeChild(currentRobot);
            currentRobot = document.createElement('div');
            currentRobot.className = 'robot-icon';
            if (deviceLabel) currentRobot.setAttribute('data-label', deviceLabel);
            mapGrid.appendChild(currentRobot);

            /*
            // XỬ LÝ LÚC RỜI ĐI GIÀNH CHO OUTBOUND
            if (movingDeviceTypeCode === 'SHUTTLE' && movingDevicePurpose === 'OUTBOUND') {
                const startLocation = nodeToLocationMap[startId];
                if (startLocation) {
                    addLog(`📦 Robot OUTBOUND mang hàng rời đi, xóa trạng thái kệ ${startLocation.code}...`, "system");
                    await MapService.updateLocationStatus(whId, startLocation.id, 0, false);
                    addLog(`✅ Đã giải phóng ô kệ ${startLocation.code}: Trạng thái 0 (AVAILABLE), is_occupied: false`, "success");
                }
            }

            // SET DEVICE STATUS TO BUSY BEFORE MOVING
            if (movingDeviceId) {
                try {
                    await MapService.updateDevice(whId, movingDeviceId, { status: 'BUSY' });
                    addLog(`🔄 Trạng thái Robot chuyển sang BUSY (Đang di chuyển)`, "system");
                    if (targetDeviceIcon) {
                        targetDeviceIcon.classList.remove('device-status-idle', 'device-status-charging', 'device-status-offline');
                        targetDeviceIcon.classList.add('device-status-busy');
                    }
                } catch (e) {
                    addLog(`❌ Cập nhật status BUSY thất bại: ${e.message}`, "error");
                }
            }
            */

            /*
            await animateRobot(path);
            addLog("🏁 Hoàn thành.", "success");
            */
            addLog("⏳ Đang chờ thiết bị di chuyển...", "system");

            if (movingDeviceId && movingDeviceMetadata) {
                const lastStep = path[path.length - 1];
                // [FIX] KHÔNG nên gán simulatedPositionMap ngay lập tức vì sẽ gây hiện tượng "nhảy cóc" 
                // icon đến đích trước khi robot thực tế di chuyển tới đó qua Telemetry.
                // simulatedPositionMap[movingDeviceId] = { x: lastStep.X, y: lastStep.Y };
                const updatedMeta = { ...movingDeviceMetadata };

                // GIỮ NGUYÊN 0-INDEX THEO YÊU CẦU REVERT
                if (updatedMeta.position) {
                    updatedMeta.position.x = lastStep.X;
                    updatedMeta.position.y = lastStep.Y;
                } else {
                    updatedMeta.x = lastStep.X;
                    updatedMeta.y = lastStep.Y;
                }

                // -> UPDATE QR CODE METADATA (Lấy trực tiếp từ node, không dùng quy luật x, y, z tự chế)
                const endNodeInfo = currentNodesMap[endId];
                const newQrcode = endNodeInfo ? (endNodeInfo.qrcode || endNodeInfo.qr_code || '') : '';
                updatedMeta.qrcode = newQrcode;

                // -> DETERMINE IDLE vs CHARGING STATUS
                let newStatus = 'IDLE';
                // Using the global zone map cache
                if (endNodeInfo && typeof globalZoneMap !== 'undefined') {
                    const zone = endNodeInfo.zone_id ? globalZoneMap[endNodeInfo.zone_id] : null;
                    if (zone) {
                        let zoneTypeCode = (zone.zone_type_id && typeof globalZoneTypeMap !== 'undefined' && globalZoneTypeMap[zone.zone_type_id]) ? globalZoneTypeMap[zone.zone_type_id].code : '';
                        let zoneTypeName = (zone.zone_type_id && typeof globalZoneTypeMap !== 'undefined' && globalZoneTypeMap[zone.zone_type_id]) ? globalZoneTypeMap[zone.zone_type_id].name : '';

                        if ((zone.code && zone.code.includes('CHARGING')) ||
                            (zone.name && zone.name.includes('CHARGING')) ||
                            zoneTypeCode.includes('CHARGING') ||
                            zoneTypeName.includes('CHARGING')) {
                            newStatus = 'CHARGING';
                        }
                    }
                }

                /*
                try {
                    await MapService.updateDevice(whId, movingDeviceId, {
                        status: newStatus,
                        metadata: updatedMeta
                    });
                    addLog(`💾 Đã cập nhật robot ${deviceLabel} -> Trạng thái: ${newStatus}, QR: ${newQrcode}, Tọa độ (${lastStep.X},${lastStep.Y})`, "success");
                    movingDeviceMetadata = updatedMeta;

                    // KIỂM TRA SHUTTLE CÓ TRONG LIFTER
                    if (movingDeviceTypeCode === 'SHUTTLE') {
                        const lifterAtPos = globalDevicesList.find(d => {
                            const type = globalDeviceTypeMap[d.device_type_id];
                            if (!type || type.code !== 'LIFTER') return false;
                            let dm = d.metadata;
                            try { if(typeof dm === 'string') dm = JSON.parse(dm); } catch(e){}
                            let dx = dm.position?.x ?? dm.x;
                            let dy = dm.position?.y ?? dm.y;
                            let dz = dm.position?.z ?? dm.z;
                            if (dx === undefined || dy === undefined) {
                                const q = parseQrCodeCoords(dm.qrcode);
                                dx = q?.x; dy = q?.y; dz = q?.z;
                            }
                            return dx === lastStep.X && dy === lastStep.Y && parseInt(dz) === currentFloorZ;
                        });
                        if (lifterAtPos) {
                            addLog(`✅ Robot ${deviceLabel} đã nằm vào Lifter ${lifterAtPos.code}`, "success");
                        }
                    }

                    // KIỂM TRA LIFTER KÉO THEO SHUTTLE
                    if (movingDeviceTypeCode === 'LIFTER') {
                        const targetZ = currentFloorZ;
                        const shuttleToCarry = globalDevicesList.find(d => {
                            const type = globalDeviceTypeMap[d.device_type_id];
                            if (!type || type.code !== 'SHUTTLE') return false;
                            if ((d.purpose || '').toUpperCase() !== (movingDevicePurpose || '').toUpperCase()) return false;
                            
                            let dm = d.metadata;
                            try { if(typeof dm === 'string') dm = JSON.parse(dm); } catch(e){}
                            let dx = dm.position?.x ?? dm.x;
                            let dy = dm.position?.y ?? dm.y;
                            let dz = dm.position?.z ?? dm.z;
                            if (dx === undefined || dy === undefined) {
                                const q = parseQrCodeCoords(dm.qrcode);
                                dx = q?.x; dy = q?.y; dz = q?.z;
                            }
                            // Shuttle đang ở tầng cũ (startNodeData.z) tại tọa độ Lifter
                            const floorTextPrev = floorSelect.options[floorSelect.selectedIndex]?.text || "1"; // Cần cẩn thận chỗ này nếu floor select đã đổi
                            // Tọa độ so khớp
                            return dx === lastStep.X && dy === lastStep.Y && parseInt(dz) !== targetZ;
                        });

                        if (shuttleToCarry) {
                            addLog(`🛗 [Lifter] Đang mang theo Shuttle ${shuttleToCarry.code} lên/xuống Tầng ${targetZ}...`, "system");
                            let sm = shuttleToCarry.metadata;
                            try { if(typeof sm === 'string') sm = JSON.parse(sm); } catch(e){}
                            if (!sm.position) sm.position = {x: lastStep.X, y: lastStep.Y};
                            else {
                                sm.position.x = lastStep.X;
                                sm.position.y = lastStep.Y;
                            }
                            delete sm.z;
                            if (sm.position) delete sm.position.z;
                            // Tìm node thực tế tại tọa độ đó ở tầng target và lấy qrcode trực tiếp từ node
                            const targetNode = Object.values(currentNodesMap).find(n => n.x === lastStep.X && n.y === lastStep.Y);
                            sm.qrcode = targetNode ? (targetNode.qrcode || targetNode.qr_code || '') : '';
                            
                            await MapService.updateDevice(whId, shuttleToCarry.id, { metadata: sm });
                            addLog(`✅ Đã đưa Shuttle ${shuttleToCarry.code} đến Tầng ${targetZ} thành công!`, "success");
                        }
                    }

                    if (targetDeviceIcon) {
                        targetDeviceIcon.classList.remove('device-status-busy');
                        targetDeviceIcon.classList.add(`device-status-${newStatus.toLowerCase()}`);
                    }
                    
                    // Logic Location cũ
                    if (movingDeviceTypeCode === 'SHUTTLE') {
                        const targetLocation = nodeToLocationMap[endId];
                        if (targetLocation) {
                            const st = movingDevicePurpose === 'OUTBOUND' ? 1 : 2;
                            await MapService.updateLocationStatus(whId, targetLocation.id, st, true);
                            setTimeout(renderGrid, 500);
                        }
                    }
                } catch (e) { addLog(`❌ Lỗi cập nhật Postgres/Location: ${e.message}`, "error"); }
                */
                addLog(`🏁 Kết thúc mô phỏng robot ${deviceLabel}`, "success");
            }

            startNodeId = endId; startNodeData = currentNodesMap[startNodeId]; endNodeId = null; movingDevicePurpose = '';
            document.querySelectorAll('.node-selected-start, .node-selected-end, .path-step-highlight').forEach(el => {
                el.classList.remove('node-selected-start', 'node-selected-end', 'path-step-highlight');
            });
            const newStartNode = document.querySelector(`[data-node-id="${startNodeId}"]`);
            if (newStartNode) newStartNode.classList.add('node-selected-start');

        } catch (err) {
            showToast("Lỗi tìm đường.");
            startNodeId = null; endNodeId = null; renderGrid();
        } finally { isPathfinding = false; }
    };

    const updateDevicePositions = (devicesList, isFullSync = false) => {
        if (!isMapStaticRendered || isRendering) return;

        // --- TỐI ƯU: Bản Full Sync chỉ dọn dẹp các Icon rác (không có trong list mới) ---
        if (isFullSync) {
            const visibleIds = new Set();
            const visibleCodes = new Set();
            devicesList.forEach(d => {
                if (d.id) visibleIds.add(d.id);
                if (d.code) visibleCodes.add(d.code);
            });

            mapGrid.querySelectorAll('.device-icon').forEach(el => {
                const id = el.getAttribute('data-id');
                const label = el.getAttribute('data-label');
                // Chỉ xóa nếu cả ID và Code đều không có trong danh sách mới
                if (!visibleIds.has(id) && !visibleCodes.has(label)) {
                    el.remove();
                    if (id && cachedDeviceElements[id]) delete cachedDeviceElements[id];
                    if (label && cachedDeviceElements[label]) delete cachedDeviceElements[label];
                }
            });

            // Xóa robot-icon giả lập nếu không phải robot đang di chuyển hiện tại
            mapGrid.querySelectorAll('.robot-icon').forEach(el => {
                if (el !== currentRobot) el.remove();
            });
        }

        const floorText = floorSelect.options[floorSelect.selectedIndex]?.text || '';
        const floorMatch = floorText.match(/\d+/);
        const currentFloorZ = floorMatch ? parseInt(floorMatch[0]) : 1;
        const floorId = floorSelect.value;
        const isFloor1 = floorText.includes('1');

        devicesList.forEach(dev => {
            let devIcon = null;
            let meta = {};
            if (dev.metadata) {
                try { meta = typeof dev.metadata === 'string' ? JSON.parse(dev.metadata) : dev.metadata; } catch (e) { }
            }

            const raw = meta.raw || {};
            // [FIX] Tìm qrCode từ MỌI nguồn: MQTT raw, metadata DB, device object (tất cả naming conventions)
            const qrValue = raw.qrCode || raw.qrcode || meta.qrcode || meta.qrCode
                || dev.qrCode || dev.qrcode || dev.qr_code || '';
            const parsedCoords = parseQrCodeCoords(qrValue);

            // [FIX] Ưu tiên qrCode (MQTT live), fallback metadata DB, fallback device top-level
            let posX, posY, posZ;
            if (parsedCoords && !(parsedCoords.x === 0 && parsedCoords.y === 0)) {
                posX = parsedCoords.x;
                posY = parsedCoords.y;
                posZ = parsedCoords.z;
            } else {
                // Fallback 1: metadata.position (từ DB)
                posX = (meta.position && meta.position.x !== undefined) ? meta.position.x : (meta.x !== undefined ? meta.x : undefined);
                posY = (meta.position && meta.position.y !== undefined) ? meta.position.y : (meta.y !== undefined ? meta.y : undefined);
                posZ = (meta.position && meta.position.z !== undefined) ? meta.position.z : (meta.z !== undefined ? meta.z : undefined);

                // Fallback 2: raw fields hoặc device top-level fields
                if (posX === undefined) posX = raw.x !== undefined ? raw.x : (dev.x !== undefined ? dev.x : undefined);
                if (posY === undefined) posY = raw.y !== undefined ? raw.y : (dev.y !== undefined ? dev.y : undefined);
                if (posZ === undefined) posZ = raw.z !== undefined ? raw.z : (dev.z !== undefined ? dev.z : undefined);
            }



            // [CRITICAL FIX] Dữ liệu từ Redis 'Fast Path' sẽ không có device_type_id.
            // Phải tham chiếu lại từ globalDevicesList để lấy đúng type của Robot.
            let actualDeviceTypeID = dev.device_type_id;
            let resolvedCode = dev.code || dev.no || '';
            if (Array.isArray(globalDevicesList)) {
                const globalDev = globalDevicesList.find(d => d.code === dev.code || d.id === dev.id || (dev.no && d.code === dev.no));
                if (globalDev) {
                    if (!actualDeviceTypeID) actualDeviceTypeID = globalDev.device_type_id;
                    if (!resolvedCode) resolvedCode = globalDev.code || '';
                }
            }

            const statusClass = `device-status-${(dev.status || 'OFFLINE').toLowerCase()}`;
            const devType = globalDeviceTypeMap[actualDeviceTypeID];

            // Logic bóc tách mang hàng - Dùng mã Thiết bị (Viết hoa) làm Key
            const cargoKey = (resolvedCode || dev.id || '').toUpperCase();
            const nPosX = Number(posX);
            const nPosY = Number(posY);

            // [DỰ PHÒNG AN TOÀN] Nếu vẫn không tìm thấy devType, mặc định nó là SHUTTLE nếu tên mã chứa từ khóa
            const isLifter = devType ? (devType.code === 'LIFTER') : (resolvedCode && resolvedCode.includes('LIFTER'));
            const isShuttle = devType ? (devType.code === 'SHUTTLE') : (resolvedCode && resolvedCode.includes('SHUTTLE'));

            if (isShuttle) {
                const nPkgStatus = Number(
                    (dev.packageStatus !== undefined) ? dev.packageStatus :
                        (meta.packageStatus !== undefined) ? meta.packageStatus :
                            (raw.packageStatus !== undefined) ? raw.packageStatus :
                                (raw.package_status !== undefined) ? raw.package_status :
                                    (dev.package_status !== undefined) ? dev.package_status :
                                        (dev.package_status === undefined && raw.packageStatus === undefined && meta.packageStatus === undefined) ? 0 : 0
                );
                // [DEBUG] console.log(`Device ${dev.code} pkgStatus: ${nPkgStatus}`);

                // [CARGO ICON RULE] Dựa trên packageStatus từ MQTT/DB
                // 1 -> có hàng (shuttle_box)
                // 2 -> lệch hàng (shuttle_misaligned)
                // 0 -> không có hàng (shuttle_emp)
                deviceWithCargoMap[cargoKey] = nPkgStatus;
            }

            // GÁN CLASS CUỐI CÙNG: Phân tách 3 trạng thái của Shuttle
            let typeClass = isLifter ? 'lifter-device' : 'shuttle-device';
            if (isShuttle) {
                const cargoState = deviceWithCargoMap[cargoKey];
                if (cargoState === 1) {
                    typeClass = 'shuttle-device-cargo';
                } else if (cargoState === 2) {
                    typeClass = 'shuttle-device-misaligned';
                }
            }

            // [ROBUST ICON RE-SYNC] 
            // 1. Tìm icon hiện có (theo ID cũ UUID hoặc theo Code SHUTTLE-XXX)
            devIcon = cachedDeviceElements[dev.id] || (dev.code ? cachedDeviceElements[dev.code] : null);

            // 2. Nếu tìm thấy theo Code nhưng ID trong data-id khác (vd từ UUID sang Code), cập nhật lại
            if (devIcon) {
                const currentId = devIcon.getAttribute('data-id');
                if (currentId !== dev.id) {
                    devIcon.setAttribute('data-id', dev.id);
                    cachedDeviceElements[dev.id] = devIcon;
                }
            } else if (isFullSync && !devIcon) {
                // Chỉ tìm kiếm thủ công trong DOM khi là FullSync và Cache chưa có
                const existingEl = mapGrid.querySelector(`.device-icon[data-id="${dev.id}"], .device-icon[data-label="${dev.code}"]`);
                if (existingEl) {
                    devIcon = existingEl;
                    cachedDeviceElements[dev.id] = devIcon;
                    if (dev.code) cachedDeviceElements[dev.code] = devIcon;
                }
            }


            // [FIX] ƯU TIÊN Tọa độ Telemetry (Real-time). 
            // Chỉ sử dụng Simulated Position khi không có bất kỳ nguồn dữ liệu tọa độ thực tế nào 
            // hoặc khi muốn ép icon về vị trí mong muốn trong lúc mất kết nối.
            if ((posX === undefined || posY === undefined || (posX === 0 && posY === 0)) && !devIcon) {
                const simPos = simulatedPositionMap[dev.id] || (dev.code ? simulatedPositionMap[dev.code] : null);
                if (simPos) {
                    posX = simPos.x;
                    posY = simPos.y;
                }
            } else if (posX !== undefined && posY !== undefined && !(posX === 0 && posY === 0)) {
                // Nếu đã bắt được tọa độ thực tế, giải phóng simulated mapping để tránh xung đột
                delete simulatedPositionMap[dev.id];
                if (dev.code) delete simulatedPositionMap[dev.code];
            }

            let shouldShow = false;
            if (dev.warehouse_floor_id === floorId) {
                shouldShow = true;
            } else if (!dev.warehouse_floor_id || dev.warehouse_floor_id === "") {
                if (posZ !== undefined) {
                    shouldShow = (posZ === currentFloorZ);
                } else if (isFloor1) {
                    shouldShow = true;
                }
            }

            // Nếu Robot đang di chuyển tìm đường (local simulation UI), ẩn icon thật
            if (isPathfinding && dev.id === movingDeviceId) {
                if (devIcon) devIcon.style.opacity = '0';
                return;
            }

            if (!shouldShow) {
                if (devIcon) {
                    devIcon.remove();
                    delete cachedDeviceElements[dev.id];
                }
                return;
            }

            if (devIcon && devIcon.style.opacity === '0') {
                devIcon.style.opacity = '1';
            }

            // [MỚI] TRÍCH XUẤT THÔNG TIN SẠC & PIN TỪ METADATA
            const chargeStatus = Number(meta.chargeDischargeStatus || raw.chargeDischargeStatus || 2);
            const isCharging = (chargeStatus === 1);
            const battery = raw.batteryPercentage || meta.batteryPercentage || meta.battery || '?';
            const errorCode = (raw.errorCode || meta.errorCode || '').toUpperCase();
            const isLowBattery = (errorCode === 'W30');

            // devType and typeClass moved to top of loop
            if (!devIcon) {
                // Tạo mới nếu thực sự chưa tồn tại
                devIcon = document.createElement('div');
                devIcon.className = `device-icon ${statusClass} ${typeClass}`;
                devIcon.setAttribute('data-id', dev.id);
                devIcon.setAttribute('data-label', dev.code);
                mapGrid.appendChild(devIcon);
                cachedDeviceElements[dev.id] = devIcon;
                if (dev.code) cachedDeviceElements[dev.code] = devIcon;

                devIcon.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (isPathfinding) return;

                    document.querySelectorAll('.device-icon').forEach(d => d.classList.remove('device-selected'));
                    devIcon.classList.add('device-selected');

                    if (posX !== undefined && posY !== undefined) {
                        const targetNode = document.querySelector(`[data-x="${posX}"][data-y="${posY}"].grid-dot`);
                        // Tìm node_id tương ứng để làm điểm bắt đầu
                        // Lưu ý: logic này cần ref node map, tôi sẽ dùng cách an toàn nhất
                        document.querySelectorAll('.map-zone-overlay').forEach(el => {
                            if (el.title && el.title.includes(`(${getColumnLabel(posX - 1)}${posY})`)) {
                                startNodeId = el.getAttribute('data-node-id');
                                document.querySelectorAll('.node-selected-start, .node-selected-end').forEach(n => n.classList.remove('node-selected-start', 'node-selected-end'));
                                el.classList.add('node-selected-start');
                            }
                        });

                        movingDeviceId = dev.id;
                        movingDeviceMetadata = meta;
                        movingDeviceTypeCode = devType ? devType.code : '';

                        try {
                            const devDetail = await MapService.fetchDeviceDetail(whId, dev.id);
                            movingDevicePurpose = devDetail?.elements?.purpose || devDetail?.data?.purpose || devDetail?.purpose || '';
                        } catch (err) {
                            movingDevicePurpose = dev.purpose || '';
                        }
                        addLog(`ℹ️ Monitor Chọn Robot: ${dev.code} - Purpose: ${movingDevicePurpose || 'None'}`, "system");
                        showToast(`Chọn Robot ${dev.code} [Real-time]`);
                    }
                });
            }

            // [FAST PATH] Cập nhật vị trí bằng Transform thay vì gridArea để di chuyển mượt mà (sub-pixel)
            const gridSize = 40 * currentZoom; // var(--grid-size)
            const iconSizeRatio = isLifter ? 1.0 : 0.80;
            const iconOffset = (gridSize - (gridSize * iconSizeRatio)) / 2;

            // [CRITICAL GUARD] Nếu tọa độ không hợp lệ → giữ nguyên vị trí cũ, KHÔNG nhảy về (0,0)
            const guardX = Number(posX);
            const guardY = Number(posY);
            if (isNaN(guardX) || isNaN(guardY) || (guardX === 0 && guardY === 0)) {
                // Thử dùng vị trí đã lưu trước đó trên DOM
                const savedX = devIcon ? Number(devIcon.getAttribute('data-x')) : NaN;
                const savedY = devIcon ? Number(devIcon.getAttribute('data-y')) : NaN;
                if (!isNaN(savedX) && !isNaN(savedY) && !(savedX === 0 && savedY === 0)) {
                    posX = savedX;
                    posY = savedY;
                } else {
                    return; // Không có tọa độ nào hợp lệ → bỏ qua thiết bị này
                }
            }

            // Calculate direction and angle of rotation for shuttle (using shortest path to avoid spin looping)
            let angle = 0;
            if (isShuttle) {
                const prevX = Number(devIcon.getAttribute('data-x'));
                const prevY = Number(devIcon.getAttribute('data-y'));
                let currentAngle = 0;
                let savedAngle = devIcon.getAttribute('data-angle');
                if (savedAngle !== null) {
                    currentAngle = Number(savedAngle);
                }

                let targetAngle = currentAngle; // Default to current angle if no movement
                if (!isNaN(prevX) && !isNaN(prevY) && !(prevX === 0 && prevY === 0)) {
                    const dx = posX - prevX;
                    const dy = posY - prevY;
                    if (dx > 0) {
                        targetAngle = 0; // Move Right -> faces Right (0 deg)
                    } else if (dx < 0) {
                        targetAngle = 180; // Move Left -> faces Left (180 deg)
                    } else if (dy > 0) {
                        targetAngle = 90; // Move Down -> faces Down (90 deg)
                    } else if (dy < 0) {
                        targetAngle = 270; // Move Up -> faces Up (270 deg)
                    }
                }

                // Find closest equivalent angle to prevent spinning looping (shortest path rotation)
                let diff = (targetAngle - currentAngle) % 360;
                if (diff > 180) {
                    diff -= 360;
                } else if (diff < -180) {
                    diff += 360;
                }
                angle = currentAngle + diff;
                devIcon.setAttribute('data-angle', angle);

                // Clean up any old head indicator if present
                const headEl = devIcon.querySelector('.shuttle-head');
                if (headEl) headEl.remove();
            } else {
                const headEl = devIcon.querySelector('.shuttle-head');
                if (headEl) headEl.remove();
            }

            const pixelX = posX * gridSize + iconOffset;
            const pixelY = posY * gridSize + iconOffset;

            // Sử dụng transform để kích hoạt tăng tốc phần cứng (GPU) cho animation
            const newTransform = isShuttle ? `translate(${pixelX}px, ${pixelY}px) rotate(${angle}deg)` : `translate(${pixelX}px, ${pixelY}px)`;
            if (devIcon.style.transform !== newTransform) {
                devIcon.style.transform = newTransform;

                // Lưu lại tọa độ vào thuộc tính để các hàm khác (như applyZoom) có thể tham chiếu
                devIcon.setAttribute('data-x', posX);
                devIcon.setAttribute('data-y', posY);

                // Nếu là Shuttle vừa thay đổi tọa độ, log nhẹ
                // if (typeClass === 'shuttle-device') {
                //     console.log(`[Fast Path] Device ${dev.code} moved to (${posX}, ${posY})`);
                // }
            }

            // Xóa gridArea cũ để tránh xung đột layout
            if (devIcon.style.gridArea) {
                devIcon.style.gridArea = '';
            }

            // [DYNAMIC CLASS MANAGEMENT]
            // Hiển thị trạng thái Sạc hoặc Cảnh báo pin yếu dựa trên Telemetry
            const finalStatusClass = isCharging ? 'device-status-charging' : (isLowBattery ? 'device-status-warning' : statusClass);

            const fullClass = `device-icon ${finalStatusClass} ${typeClass} ${isFloor1 ? 'floor-1-highlight' : ''}`;
            if (devIcon.className !== fullClass) {
                devIcon.className = fullClass;
            }

            const extraInfo = errorCode ? ` [Error: ${errorCode}]` : '';
            const chargingTag = isCharging ? ' [ĐANG SẠC]' : '';
            devIcon.title = `Thiết bị: ${dev.code}\nTrạng thái: ${dev.status}${chargingTag}\nPin: ${battery}%${extraInfo}\nTọa độ: (${getColumnLabel(posX - 1)}, ${posY}, Z:${posZ})`;

            // LOGIC THEO DÕI LỘ TRÌNH REAL-TIME
            if (activePathForTracking && trackedDeviceId === dev.id) {
                // Tìm xem tọa độ hiện tại khớp với bước nào trong lộ trình
                const currentStepIdx = activePathForTracking.findIndex(step => step.X === posX && step.Y === posY);

                if (currentStepIdx > lastLoggedNodeIdx) {
                    // Log tất cả các bước từ lastLoggedNodeIdx + 1 đến currentStepIdx
                    for (let i = lastLoggedNodeIdx + 1; i <= currentStepIdx; i++) {
                        const step = activePathForTracking[i];
                        const nodeInfo = currentNodesMap[step.NodeID];
                        const displayId = nodeInfo ? (nodeInfo.code || '').replace(/^NODE-/, '') : step.NodeID;

                        addLog(`   [${i}] <b>${displayId}</b> | Tọa độ: (${step.X}, ${step.Y})`, "path");
                    }
                    lastLoggedNodeIdx = currentStepIdx;

                    // Nếu đã đi đến bước cuối cùng của lộ trình
                    if (currentStepIdx === activePathForTracking.length - 1) {
                        addLog(`🏁 Thiết bị ${dev.code} đã hoàn thành lộ trình thực tế.`, "success");
                        activePathForTracking = null;
                        trackedDeviceId = null;
                        lastLoggedNodeIdx = -1;
                    }
                }
            }
        });
    };

    const updateCargoStatus = (locations) => {
        // ... (existing code stays)
        if (!isMapStaticRendered || isPathfinding) return;

        const floorText = floorSelect.options[floorSelect.selectedIndex]?.text || '';
        const floorMatch = floorText.match(/\d+/);
        const currentFloorZ = floorMatch ? parseInt(floorMatch[0]) : 1;

        locations.forEach(loc => {
            // [CRITICAL FIX] Lọc theo tầng (Z) để tránh 'Ghost Icon' xuất hiện ở các tầng khác cùng tọa độ X,Y
            let locZ = loc.z;
            if (locZ === undefined || locZ === null) {
                // Fallback: Tìm trong map cache nếu loc không có Z
                const node = currentNodesMap[loc.node_id];
                if (node) locZ = node.z;
            }

            // Nếu xác định được Z và khác tầng hiện tại -> Xóa icon cũ (nếu có) và bỏ qua
            if (locZ !== undefined && locZ !== null && Number(locZ) !== currentFloorZ) {
                const existingGhost = document.querySelector(`.cargo-icon[data-location-id="${loc.id}"]`);
                if (existingGhost) existingGhost.remove();
                return;
            }

            const isOccupied = (loc.is_occupied === true || loc.is_occupied === 1 || String(loc.is_occupied).toLowerCase() === 'true');
            let cargoIcon = document.querySelector(`.cargo-icon[data-location-id="${loc.id}"]`);

            if (isOccupied) {
                if (!cargoIcon) {
                    // Xác định tọa độ hiển thị: Ưu tiên node mapping nếu loc.x/y bị rỗng
                    let tx = loc.x;
                    let ty = loc.y;
                    if (tx === null || ty === null || tx === undefined || ty === undefined) {
                        const node = currentNodesMap[loc.node_id];
                        if (node) { tx = node.x; ty = node.y; }
                    }

                    if (tx !== undefined && ty !== undefined && tx !== null && ty !== null) {
                        cargoIcon = document.createElement('div');
                        cargoIcon.className = 'zone-icon cargo-icon';
                        cargoIcon.style.gridArea = `${ty + 1} / ${tx + 1}`;
                        cargoIcon.setAttribute('data-location-id', loc.id);
                        mapGrid.appendChild(cargoIcon);
                        console.log(`[Realtime] Added cargo icon for Location ${loc.code} at (${tx}, ${ty})`);
                    }
                }
            } else {
                if (cargoIcon) {
                    cargoIcon.remove();
                    console.log(`[Realtime] Removed cargo icon for Location ${loc.code}`);
                }
            }

            // [MỚI] Đồng bộ lại nodeToLocationMap để dùng cho các logic khác
            if (loc.node_id) nodeToLocationMap[loc.node_id] = loc;

            // Cập nhật Tooltip của Node tương ứng
            if (loc.node_id) {
                const nodeEl = document.querySelector(`[data-node-id="${loc.node_id}"]`);
                if (nodeEl) {
                    const nodeData = currentNodesMap[loc.node_id];
                    if (nodeData) {
                        const zone = nodeData.zone_id ? globalZoneMap[nodeData.zone_id] : null;
                        const zoneInfo = zone ? `\nKhu vực: ${zone.name} (${zone.code})` : '';
                        const qrInfo = nodeData.qrcode ? `\nQR Code: ${nodeData.qrcode}` : '';
                        const occupiedInfo = `\nLocation: ${loc.code}\nTrạng thái: ${isOccupied ? 'CÓ HÀNG' : 'TRỐNG'}`;
                        nodeEl.title = `${nodeData.name} (${nodeData.code})${zoneInfo}${qrInfo}${occupiedInfo}\nTọa độ: ${getColumnLabel(nodeData.x - 1)}${nodeData.y}`;
                    }
                }
            }
        });
    };

    const taskCache = {}; // Lưu trữ metadata đầy đủ của từng Task để bù đắp cho 'Fast Path'

    const updateTaskLogs = (tasksList) => {
        if (!tasksList || tasksList.length === 0) return;

        tasksList.forEach(task => {
            const taskId = task.id;
            if (!taskId) return;

            // [ROBUST DEDUPLICATION & PROGRESSION GUARD]
            const status = (task.status || '').toUpperCase();

            // Nếu đã xử lý trạng thái này thì bỏ qua
            if (lastProcessedTasks[taskId] === status) return;

            // GUARD: Nếu Robot đã RUNNING/COMPLETED, tuyệt đối không hiện lại Log PENDING (do Kafka chậm)
            const statusOrder = { 'PENDING': 0, 'RUNNING': 1, 'COMPLETED': 2, 'FAILED': 3, 'ERROR': 3 };
            const lastStatus = lastProcessedTasks[taskId];
            if (lastStatus && statusOrder[status] <= statusOrder[lastStatus]) {
                return;
            }

            // BÙ ĐẮP DỮ LIỆU (Metadata Recovery for Fast Path)
            if (!task.task_type && taskCache[taskId]) task.task_type = taskCache[taskId].task_type;
            if (!task.device_id && taskCache[taskId]) task.device_id = taskCache[taskId].device_id;
            if (!task.from_node_id && taskCache[taskId]) task.from_node_id = taskCache[taskId].from_node_id;
            if (!task.to_node_id && taskCache[taskId]) task.to_node_id = taskCache[taskId].to_node_id;
            if (!task.from_node_label && taskCache[taskId]) task.from_node_label = taskCache[taskId].from_node_label;
            if (!task.to_node_label && taskCache[taskId]) task.to_node_label = taskCache[taskId].to_node_label;

            // Lưu lại cache cho các bản tin sau
            taskCache[taskId] = { ...taskCache[taskId], ...task };

            const type = (task.task_type || '').toUpperCase();
            const devId = task.device_id;

            // Tìm code của device
            let device = globalDevicesList.find(d => d.id === devId || d.code === task.device_code);
            // Fallback: nếu devId rỗng, thử tìm robot đang có "Pathfinding" active cho taskId này
            if (!device && trackedDeviceId) device = globalDevicesList.find(d => d.id === trackedDeviceId);

            const hasDevice = !!device || !!devId;
            const devName = device ? device.code : (devId ? `Robot [${devId.slice(0, 5)}]` : 'Thiết bị');

            // [OPTIMIZATION-1] Skip 'PENDING' spam for unassigned tasks
            if (status === 'PENDING' && !hasDevice) return;

            // Helper: Dịch Node ID thành Tọa độ thân thiện bao gồm Tầng (vd: 1C5, 2E7)
            const getNodeLabel = (nodeId) => {
                if (!nodeId || !currentNodesMap[nodeId]) return '';
                const node = currentNodesMap[nodeId];
                const floor = node.z !== undefined ? node.z : 1;
                return `${floor}${getColumnLabel(node.x - 1)}${node.y}`;
            };

            // Ưu tiên Label từ Backend (đã quy đổi sẵn cho cả các tầng khác)
            const fromLabel = task.from_node_label || getNodeLabel(task.from_node_id);
            const toLabel = task.to_node_label || getNodeLabel(task.to_node_id);

            const toSuffix = toLabel ? ` vị trí ${toLabel}` : "";
            const fromSuffix = fromLabel ? ` tại vị trí ${fromLabel}` : "";

            // [ENHANCED LABELING] Handle Floor Transitions and Lifter specifics
            const fromFloor = fromLabel ? fromLabel.match(/^\d+/)?.[0] : null;
            const toFloor = toLabel ? toLabel.match(/^\d+/)?.[0] : null;
            const isFloorChange = fromFloor && toFloor && fromFloor !== toFloor;
            const isLifter = device ? (globalDeviceTypeMap[device.device_type_id]?.code === 'LIFTER') : (devName.includes('LIFTER'));

            let message = "";
            let logType = "info";

            if (status === 'PENDING') {
                message = `${devName} đang chờ nhận lệnh.`;
                logType = "system";
            } else if (status === 'RUNNING') {
                if (isLifter && isFloorChange) {
                    const direction = parseInt(toFloor) > parseInt(fromFloor) ? "lên" : "xuống";
                    message = `${devName} đang di chuyển ${direction} Tầng ${toFloor}.`;
                } else if (!isLifter && isFloorChange) {
                    message = `${devName} đang di chuyển sang Tầng ${toFloor} (vị trí ${toLabel}).`;
                } else if (type === 'MOVE') {
                    message = `${devName} đang di chuyển đến${toSuffix}.`;
                } else if (type === 'UNLOAD') {
                    message = `${devName} đang đặt hàng tại${toSuffix}.`;
                } else if (type === 'LOAD') {
                    message = `${devName} đang lấy hàng${fromSuffix}.`;
                } else {
                    message = `${devName} đang thực hiện tác vụ ${type}.`;
                }
                logType = "path";
            } else if (status === 'COMPLETED') {
                if (isLifter && isFloorChange) {
                    message = `${devName} đã di chuyển đến Tầng ${toFloor} thành công.`;
                } else if (!isLifter && isFloorChange) {
                    message = `${devName} đã đến Tầng ${toFloor} (vị trí ${toLabel}).`;
                } else if (type === 'MOVE') {
                    message = `${devName} đã đến${toSuffix}.`;
                } else if (type === 'UNLOAD') {
                    message = `${devName} đã đặt hàng thành công tại${toSuffix}.`;
                } else if (type === 'LOAD') {
                    message = `${devName} đã lấy hàng thành công${fromSuffix}.`;
                } else {
                    message = `${devName} đã hoàn thành nhiệm vụ ${type}.`;
                }
                logType = "success";
            } else if (status === 'FAILED') {
                message = `${devName} thực hiện nhiệm vụ thất bại.`;
                logType = "error";
            } else if (status === 'ERROR') {
                message = `${devName} đã xảy ra lỗi trong quá trình vận hành!`;
                logType = "error";
            }

            if (message) {
                const logsContainer = document.getElementById('task-log-body');
                const lastLog = logsContainer ? logsContainer.lastElementChild : null;
                if (lastLog && lastLog.textContent.includes(message)) return;

                addTaskLog(message, logType);
                lastProcessedTasks[taskId] = status;

                // Cập nhật 'Tức thời' trạng thái Robot mang hàng và Location dựa trên Task
                if (status === 'COMPLETED') {
                    // 1. Cập nhật Icon Robot (Dùng Code để đồng bộ với Telemetry)
                    const cargoKey = device ? device.code : devId;
                    if (type === 'LOAD') {
                        deviceWithCargoMap[cargoKey] = true;
                        updateDevicePositions(globalDevicesList, false);
                    } else if (type === 'UNLOAD') {
                        deviceWithCargoMap[cargoKey] = false;
                        updateDevicePositions(globalDevicesList, false);
                    }

                    // 2. Cập nhật trạng thái ô kệ (Location)
                    const targetNodeId = (type === 'UNLOAD') ? task.to_node_id : (type === 'LOAD' ? task.from_node_id : null);
                    if (targetNodeId) {
                        const loc = nodeToLocationMap[targetNodeId];
                        if (loc) {
                            console.log(`[Instant Update] Task ${type} done. Updating Location ${loc.code} state.`);
                            loc.is_occupied = (type === 'UNLOAD'); // UNLOAD xong -> có hàng, LOAD xong -> trống
                            updateCargoStatus([loc]); // Cập nhật ngay lên bản đồ
                        }
                    }
                }
            }
        });
    };

    const refreshCargo = async () => {
        const whId = warehouseSelect.value;
        const floorId = floorSelect.value;
        if (!whId || !floorId || isRendering) return;

        try {
            // 1. Cập nhật thiết bị (Dùng Full Sync để xóa ghost icons)
            const devicesRes = await MapService.fetchDevices(whId);
            const devicesList = devicesRes ? (devicesRes.elements || devicesRes.data || []) : [];
            globalDevicesList = devicesList;
            updateDevicePositions(devicesList, true);

            // 2. Cập nhật Log Task
            const tasksRes = await MapService.fetchTasks(whId);
            const tasksList = tasksRes ? (tasksRes.elements || tasksRes.data || []) : [];
            updateTaskLogs(tasksList);

            // 3. Cập nhật vị trí/hàng hóa (Location) - TỐI ƯU HÓA SONG SONG
            const floorText = floorSelect.options[floorSelect.selectedIndex]?.text || "";
            const floorMatch = floorText.match(/\d+/);
            const currentFloorZ = floorMatch ? parseInt(floorMatch[0]) : 1;

            // Gọi 10 trang song song để bắt kịp mọi thay đổi nhanh nhất
            const pageSizes = Array.from({ length: 10 }, (_, i) => i + 1);
            const locationResponses = await Promise.all(pageSizes.map(p => MapService.fetchLocations(whId, p)));

            let locations = [];
            locationResponses.forEach(res => {
                const elements = res ? (res.elements || res.data || []) : [];
                const floorElements = elements.filter(loc => loc.z === currentFloorZ);
                locations = locations.concat(floorElements);
            });
            updateCargoStatus(locations);
        } catch (e) { }
    };

    // Tự động làm mới định kỳ (mỗi 10 giây) để dọn dẹp tuyệt đối mọi bóng ma. 
    // Không nên để quá thấp (như 0.1s) vì sẽ gây lỗi 429 (Too Many Requests) cho API.
    setInterval(refreshCargo, 10000);
    init();
});
