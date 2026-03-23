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

    // Global Maps
    let globalZoneMap = {};
    let globalZoneTypeMap = {};
    let globalDevicesList = []; // Danh sách thiết bị toàn cục
    let globalDeviceTypeMap = {}; // Danh sách loại thiết bị toàn cục
    let startNodeData = null; // Lưu thông tin node bắt đầu

    // Login Elements
    const loginModal = document.getElementById('login-modal');
    const loginForm = document.getElementById('login-form');
    const logoutBtn = document.getElementById('logout-btn');
    const userInfo = document.getElementById('user-info');
    const usernameDisplay = document.getElementById('username-display');
    const errorToast = document.getElementById('error-toast');

    let currentZoom = 1;
    let isRendering = false; // Flag chống render chồng chéo

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
     * Trả về màu sắc ĐỘC NHẤT cho mỗi zone_id, đảm bảo phân tách rõ rệt các khu vực quan trọng
     */
    const getZoneColor = (zone) => {
        if (!zone || !zone.id) return { bg: 'rgba(236, 240, 241, 0.2)', border: 'rgba(189, 195, 199, 0.4)' };

        // 1. Hash ID kết hợp thêm muối (Salt) từ tên và Code của Zone để tối đa sự khác biệt
        let hash = 0;
        const name = (zone.name || '').toUpperCase();
        const code = (zone.code || '').toUpperCase();
        const str = zone.id + name + code;
        for (let i = 0; i < str.length; i++) {
            hash = (hash << 5) - hash + str.charCodeAt(i);
            hash |= 0;
        }

        // 2. Sử dụng Golden Ratio để phân bổ sắc độ (Hue) đều trên vòng tròn màu
        const phi = 0.618033988749895;
        let h = (Math.abs(hash) * phi) % 1;
        const hue = Math.floor(h * 360);

        // 3. Biến thiên Độ bão hòa và Độ sáng dựa trên hash để tránh trùng lặp 
        // ngay cả khi Hue tình cờ ở gần nhau
        const sat = 75 + (Math.abs(hash % 15)); // 75-90%
        const light = 55 + (Math.abs((hash >> 4) % 15)); // 55-70%

        return {
            bg: `hsla(${hue}, ${sat}%, ${light}%, 0.35)`,
            border: `hsla(${hue}, ${sat}%, ${light - 25}%, 1)`
        };
    };

    /**
     * Bóc tách tọa độ x, y, z từ qrcode định dạng: [Z]X[XXXX]Y[YYYY]
     * Ví dụ: 1X0009Y0009 -> x=9, y=9, z=1
     */
    const parseQrCodeCoords = (qrcode) => {
        if (!qrcode || typeof qrcode !== 'string') return null;
        const match = qrcode.match(/^(\d+)X(\d+)Y(\d+)$/i);
        if (match) {
            return {
                z: parseInt(match[1]),
                x: parseInt(match[2]),
                y: parseInt(match[3])
            };
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

    warehouseSelect.addEventListener('change', async () => {
        const whId = warehouseSelect.value;
        floorSelect.innerHTML = '<option value="">Chọn tầng...</option>';
        mapGrid.innerHTML = '';
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
            }
        } catch (error) {
            if (error.message === '401') return;
            showToast("Không thể tải danh sách tầng.");
        }
    });

    floorSelect.addEventListener('change', () => {
        renderGrid();
    });

    // Hàm render lưới và các đối tượng (Zone, Node) - TỐI ƯU HÓA ỔN ĐỊNH
    const renderGrid = async (isSilent = false) => {
        const whId = warehouseSelect.value;
        const floorId = floorSelect.value;
        if (!whId || !floorId || isRendering) return;

        isRendering = true;

        let overlay;
        if (!isSilent) {
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

            const [nodesRes, zonesRes, zoneTypesRes, deviceTypesRes, devicesRes] = await Promise.all([
                MapService.fetchNodes(whId, floorId),
                MapService.fetchZones(whId, floorId),
                MapService.fetchZoneTypes(),
                MapService.fetchDeviceTypes(),
                MapService.fetchDevices(whId)
            ]);

            const nodes = nodesRes ? (nodesRes.elements || nodesRes.data || []) : [];
            const zones = zonesRes ? (zonesRes.elements || zonesRes.data || []) : [];
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
            mapGrid.style.gridTemplateColumns = `40px repeat(${columns}, 40px)`;
            mapGrid.style.gridTemplateRows = `40px repeat(${rows}, 40px)`;

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

            // Cập nhật bảng chú thích (Legend)
            updateIconLegend(); // Chú thích biểu tượng
            updateZoneLegend(zones); // Chú thích màu sắc khu vực

            const coordToNodeMap = {};
            currentNodesMap = {};

            nodes.forEach(node => {
                if (node.x !== undefined && node.y !== undefined) {
                    currentNodesMap[node.id] = node;
                    // SỬ DỤNG TRỰC TIẾP TỌA ĐỘ 1-INDEX TỪ API
                    coordToNodeMap[`${node.x}:${node.y}`] = node;

                    const row = node.y + 1;
                    const col = node.x + 1;
                    const gridPos = `${row} / ${col} / ${row + 1} / ${col + 1}`;

                    const nodeHighlight = document.createElement('div');
                    nodeHighlight.className = 'map-zone-overlay';
                    nodeHighlight.style.gridArea = gridPos;
                    nodeHighlight.setAttribute('data-node-id', node.id);

                    const zone = node.zone_id ? globalZoneMap[node.zone_id] : null;
                    const zoneInfo = zone ? `\nKhu vực: ${zone.name} (${zone.code})` : '';
                    const qrInfo = node.qrcode ? `\nQR Code: ${node.qrcode}` : '';

                    let location = nodeToLocationMap[node.id] || coordToLocationMap[`${node.x}:${node.y}`];
                    let occupiedInfo = location ? `\nLocation: ${location.code}\nTrạng thái: ${location.is_occupied ? 'CÓ HÀNG' : 'TRỐNG'}` : '\nChưa có location';

                    nodeHighlight.title = `${node.name} (${node.code})${zoneInfo}${qrInfo}${occupiedInfo}\nTọa độ: ${getColumnLabel(node.x - 1)}${node.y}`;
                    nodeHighlight.style.pointerEvents = 'auto';
                    nodeHighlight.style.cursor = 'pointer';
                    nodeHighlight.style.position = 'relative';

                    // Áp dụng màu sắc đồng bộ theo zone_id
                    const { bg, border } = getZoneColor(zone);
                    nodeHighlight.style.backgroundColor = bg;
                    nodeHighlight.style.borderColor = border;

                    // Thêm label tên node (bỏ phần NODE- từ code)
                    const nodeNameLabel = document.createElement('div');
                    nodeNameLabel.className = 'node-map-label';
                    nodeNameLabel.textContent = (node.code || '').replace(/^NODE-/, '');
                    nodeHighlight.appendChild(nodeNameLabel);

                    fragment.appendChild(nodeHighlight);

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

                    let zoneTypeCode = (zone && zone.zone_type_id && globalZoneTypeMap[zone.zone_type_id]) ? globalZoneTypeMap[zone.zone_type_id].code : '';
                    if (zone && (zone.code.includes('CHARGING') || zone.name.includes('CHARGING'))) {
                        const icon = document.createElement('div');
                        icon.className = 'zone-icon charging-icon small-icon';
                        icon.style.gridArea = gridPos;
                        fragment.appendChild(icon);
                    } else if (zoneTypeCode.includes('WAITING') || zoneTypeCode.includes('WAIT')) {
                        const icon = document.createElement('div');
                        icon.className = 'zone-icon waiting-icon small-icon';
                        icon.style.gridArea = gridPos;
                        fragment.appendChild(icon);
                    } else if (zoneTypeCode.includes('LIFTER')) {
                        const icon = document.createElement('div');
                        icon.className = 'zone-icon lifter-icon small-icon';
                        icon.style.gridArea = gridPos;
                        fragment.appendChild(icon);
                    }

                    // Thêm icon Import cho khu vực KV_INBOUND
                    if (zone && zone.code === 'KV_INBOUND') {
                        const icon = document.createElement('div');
                        icon.className = 'zone-icon import-icon small-icon';
                        icon.style.gridArea = gridPos;
                        fragment.appendChild(icon);
                    }

                    // Thêm icon Export cho khu vực KV_OUTBOUND
                    if (zone && zone.code === 'KV_OUTBOUND') {
                        const icon = document.createElement('div');
                        icon.className = 'zone-icon export-icon small-icon';
                        icon.style.gridArea = gridPos;
                        fragment.appendChild(icon);
                    }

                    // Hiển thị icon hàng hóa (Cargo) nếu ô này có hàng
                    // nodeToLocationMap đã được populate từ danh sách locations phía trên
                    if (location && (location.is_occupied === true || location.is_occupied === 1 || String(location.is_occupied).toLowerCase() === 'true')) {
                        const icon = document.createElement('div');
                        icon.className = 'zone-icon cargo-icon';
                        icon.style.gridArea = gridPos;
                        // Đảm bảo icon box_icon.png được hiển thị (css class cargo-icon xử lý việc này)
                        fragment.appendChild(icon);
                    }
                }
            });

            // 5. Render Devices
            const selectedFloorName = floorSelect.options[floorSelect.selectedIndex]?.text || '';
            const isFloor1 = selectedFloorName.includes('1');

            devicesList.forEach(dev => {
                let meta = {};
                if (dev.metadata) {
                    try { meta = typeof dev.metadata === 'string' ? JSON.parse(dev.metadata) : dev.metadata; } catch (e) { }
                }

                let parsedCoords = parseQrCodeCoords(meta.qrcode);
                let posX = (meta.position && meta.position.x !== undefined) ? meta.position.x : (meta.x !== undefined ? meta.x : (parsedCoords ? parsedCoords.x : undefined));
                let posY = (meta.position && meta.position.y !== undefined) ? meta.position.y : (meta.y !== undefined ? meta.y : (parsedCoords ? parsedCoords.y : undefined));
                let posZ = (meta.position && meta.position.z !== undefined) ? meta.position.z : (meta.z !== undefined ? meta.z : (parsedCoords ? parsedCoords.z : undefined));

                if (simulatedPositionMap[dev.id]) {
                    posX = simulatedPositionMap[dev.id].x;
                    posY = simulatedPositionMap[dev.id].y;
                }

                if (posX !== undefined && posY !== undefined) {
                    let shouldShow = false;
                    if (dev.warehouse_floor_id === floorId) {
                        shouldShow = true;
                    } else if (!dev.warehouse_floor_id || dev.warehouse_floor_id === "") {
                        // Nếu không có gán floor_id, ưu tiên dùng Z từ qrcode/metadata để so với currentFloorZ
                        if (posZ !== undefined) {
                            shouldShow = (posZ === currentFloorZ);
                        } else if (isFloor1) {
                            // Fallback cuối cùng nếu không có thông tin tọa độ Z thì hiển thị ở tầng 1
                            shouldShow = true;
                        }
                    }

                    if (!shouldShow) return;

                    const devIcon = document.createElement('div');
                    const statusClass = `device-status-${(dev.status || 'OFFLINE').toLowerCase()}`;

                    // Xác định icon theo device type
                    const devType = deviceTypeMap[dev.device_type_id];
                    const typeClass = (devType && devType.code === 'LIFTER') ? 'lifter-device' : 'shuttle-device';

                    devIcon.className = `device-icon ${statusClass} ${typeClass}`;
                    devIcon.setAttribute('data-id', dev.id);
                    devIcon.setAttribute('data-x', posX);
                    devIcon.setAttribute('data-y', posY);
                    devIcon.style.gridArea = `${posY + 1} / ${posX + 1}`;
                    devIcon.setAttribute('data-label', dev.code);
                    devIcon.title = `Thiết bị: ${dev.code}\nTrạng thái: ${dev.status}\nPin: ${meta.battery || '?'}%\nTọa độ: (${getColumnLabel(posX - 1)}, ${posY})`;

                    devIcon.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        if (isPathfinding) return;

                        // Reset selection UI
                        document.querySelectorAll('.device-icon').forEach(d => d.classList.remove('device-selected'));
                        devIcon.classList.add('device-selected');

                        const targetNode = coordToNodeMap[`${posX}:${posY}`];
                        if (targetNode) {
                            document.querySelectorAll('.node-selected-start, .node-selected-end').forEach(el => el.classList.remove('node-selected-start', 'node-selected-end'));
                            startNodeId = targetNode.id;
                            endNodeId = null;
                            movingDeviceId = dev.id;
                            movingDeviceMetadata = meta;
                            movingDeviceTypeCode = devType ? devType.code : '';

                            // Gọi API lấy mục đích thiết bị
                            try {
                                showToast(`Đang tải dữ liệu Device ${dev.code}...`);
                                const devDetail = await MapService.fetchDeviceDetail(whId, dev.id);
                                if (devDetail && devDetail.elements) {
                                    movingDevicePurpose = devDetail.elements.purpose || '';
                                } else if (devDetail && devDetail.data) {
                                    movingDevicePurpose = devDetail.data.purpose || '';
                                } else if (devDetail) {
                                    movingDevicePurpose = devDetail.purpose || '';
                                }
                            } catch (err) {
                                console.error("Could not fetch device detail", err);
                                movingDevicePurpose = dev.purpose || ''; // Fallback
                            }
                            addLog(`ℹ️ Chọn Robot: ${dev.code} - Mục đích (Purpose): ${movingDevicePurpose || 'Không xác định'}`, "system");

                            const nodeEl = document.querySelector(`[data-node-id="${startNodeId}"]`);
                            if (nodeEl) nodeEl.classList.add('node-selected-start');
                            showToast(`Đã chọn Robot ${dev.code} làm điểm bắt đầu.`);
                        }
                    });
                    fragment.appendChild(devIcon);
                }
            });

            mapGrid.innerHTML = '';
            const pathSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            pathSvg.id = 'path-svg';
            pathSvg.setAttribute("class", "path-svg");
            // Đảm bảo SVG bao phủ toàn bộ grid để tọa độ (x,y) vẽ lên đúng vị trí
            pathSvg.style.gridArea = '1 / 1 / -1 / -1';
            mapGrid.appendChild(pathSvg);
            mapGrid.appendChild(fragment);

        } catch (error) {
            if (error.message !== '401') showToast("Lỗi khi tải dữ liệu bản đồ.");
        } finally {
            isRendering = false;
            if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }
    };

    const applyZoom = () => { mapGrid.style.transform = `scale(${currentZoom})`; };
    document.getElementById('zoom-in').addEventListener('click', () => { if (currentZoom < 4) { currentZoom += 0.2; applyZoom(); } });
    document.getElementById('zoom-out').addEventListener('click', () => { if (currentZoom > 0.3) { currentZoom -= 0.2; applyZoom(); } });

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
            { class: 'waiting-icon', name: 'Khu vực chờ', isZone: true },
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
                iconInner.className = `device-icon ${item.class}`;
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

    const updateZoneLegend = (zones) => {
        const legendBody = document.getElementById('legend-colors-body');
        if (!legendBody) return;

        if (!zones || zones.length === 0) {
            legendBody.innerHTML = '<div class="legend-item-placeholder">Không có zone nào...</div>';
            return;
        }

        const uniqueZones = [];
        const seenIds = new Set();
        zones.forEach(z => {
            if (!seenIds.has(z.id)) {
                seenIds.add(z.id);
                uniqueZones.push(z);
            }
        });

        uniqueZones.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        legendBody.innerHTML = '';
        uniqueZones.forEach(zone => {
            const { bg, border } = getZoneColor(zone);
            const item = document.createElement('div');
            item.className = 'legend-item';
            item.innerHTML = `
                <div class="legend-color-box" style="background-color: ${bg}; border: 1.5px solid ${border}"></div>
                <div class="legend-name" title="${zone.name}">${zone.name}</div>
                <div class="legend-code">${zone.code || ''}</div>
            `;
            legendBody.appendChild(item);
        });
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
            const cx = step.X * 40 + 20;
            const cy = step.Y * 40 + 20;

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

            await animateRobot(path);
            addLog("🏁 Hoàn thành.", "success");

            if (movingDeviceId && movingDeviceMetadata) {
                const lastStep = path[path.length - 1];
                simulatedPositionMap[movingDeviceId] = { x: lastStep.X, y: lastStep.Y };
                const updatedMeta = { ...movingDeviceMetadata };

                // GIỮ NGUYÊN 0-INDEX THEO YÊU CẦU REVERT
                if (updatedMeta.position) {
                    updatedMeta.position.x = lastStep.X;
                    updatedMeta.position.y = lastStep.Y;
                } else {
                    updatedMeta.x = lastStep.X;
                    updatedMeta.y = lastStep.Y;
                }

                // -> UPDATE QR CODE METADATA
                const floorText = floorSelect.options[floorSelect.selectedIndex]?.text || "1";
                const floorMatch = floorText.match(/\d+/);
                const currentFloorZ = floorMatch ? parseInt(floorMatch[0]) : 1;
                const padStr = (num) => String(num).padStart(4, '0');
                const newQrcode = `${currentFloorZ}X${padStr(lastStep.X)}Y${padStr(lastStep.Y)}`;
                updatedMeta.qrcode = newQrcode;

                // -> DETERMINE IDLE vs CHARGING STATUS
                let newStatus = 'IDLE';
                const endNodeInfo = currentNodesMap[endId];
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
                            const padStr = (num) => String(num).padStart(4, '0');
                            sm.qrcode = `${targetZ}X${padStr(lastStep.X)}Y${padStr(lastStep.Y)}`;
                            
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

    const refreshCargo = async () => {
        const whId = warehouseSelect.value;
        const floorId = floorSelect.value;
        if (!whId || !floorId || isPathfinding || isRendering) return;
        try { renderGrid(true); } catch (e) { }
    };

    setInterval(refreshCargo, 5000);
    init();
});
