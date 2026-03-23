// api.js - File gọi API thực tế từ gateway
const API_BASE_URL = 'http://localhost:8888/api/v2';

const MapService = {
    onUnauthorized: null,
    isUnauthorizedFiring: false, // Flag để chống bắn nhiều lần 401 cùng lúc

    /**
     * Helper để gọi fetch với handle error và parse JSON
     */
    async callApi(endpoint, options = {}) {
        const token = localStorage.getItem('access_token');
        const headers = {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
            ...options.headers
        };

        try {
            const response = await fetch(`${API_BASE_URL}${endpoint}`, {
                ...options,
                headers
            });

            if (response.status === 401) {
                if (!this.isUnauthorizedFiring) {
                    this.isUnauthorizedFiring = true;
                    console.warn('[API] Unauthorized access - redirecting to login');
                    localStorage.removeItem('access_token');
                    if (this.onUnauthorized) this.onUnauthorized();
                    // Reset flag sau 1s
                    setTimeout(() => { this.isUnauthorizedFiring = false; }, 1000);
                }
                throw new Error('401');
            }

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.message || `Lỗi API: ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            if (error.message !== '401') {
                console.error(`[API Error] ${endpoint}:`, error);
            }
            throw error;
        }
    },

    /**
     * Đăng nhập
     */
    async login(username, password) {
        const response = await this.callApi('/authorization', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });
        if (response && response.elements && response.elements.token) {
            localStorage.setItem('access_token', response.elements.token);
            return response;
        }
        throw new Error('Đăng nhập thất bại (không nhận được token)');
    },

    /**
     * Đăng xuất
     */
    async logout() {
        localStorage.removeItem('access_token');
        if (this.onUnauthorized) this.onUnauthorized();
    },

    /**
     * Lấy danh sách kho
     */
    async fetchWarehouses() {
        return this.callApi('/warehouse?limit=100');
    },

    /**
     * Lấy danh sách tầng của một kho
     */
    async fetchFloors(warehouseId) {
        if (!warehouseId) return null;
        return this.callApi(`/warehouse/${warehouseId}/floor?limit=100`);
    },

    /**
     * Lấy danh sách zone theo tầng
     */
    async fetchZones(warehouseId, floorId) {
        if (!warehouseId || !floorId) return null;
        return this.callApi(`/warehouse/${warehouseId}/zone?floor_id=${floorId}&limit=500`);
    },

    /**
     * Lấy danh sách node theo tầng
     */
    async fetchNodes(warehouseId, floorId) {
        if (!warehouseId || !floorId) return null;
        // Node API trên gateway dùng tham số 'pagesize' thay vì 'limit'
        return this.callApi(`/warehouse/${warehouseId}/nodes?warehouse_floor_id=${floorId}&pagesize=2000`);
    },

    /**
     * Lấy danh sách location (để biết ô nào có hàng)
     */
    async fetchLocations(warehouseId, page = 1) {
        if (!warehouseId) return null;
        return this.callApi(`/warehouse/${warehouseId}/locations?page=${page}&pagesize=500`);
    },

    /**
     * Lấy thông tin chi tiết warehouse
     */
    async fetchWarehouseDetail(warehouseId) {
        if (!warehouseId) return null;
        return this.callApi(`/warehouse/${warehouseId}`);
    },

    /**
     * Lấy danh sách zone type
     */
    async fetchZoneTypes() {
        return this.callApi(`/zone-type?limit=100`);
    },

    /**
     * Lấy đường đi từ traffic-control-system (Port 8082)
     */
    async fetchPath(warehouseId, startNodeId, endNodeId, purpose = '') {
        try {
            const upperPurpose = (purpose || '').toUpperCase();
            const purposeQuery = upperPurpose ? `&purpose=${upperPurpose}` : '';
            const response = await fetch(`http://localhost:8082/debug/map-state/${warehouseId}/find-path?start=${startNodeId}&end=${endNodeId}${purposeQuery}`);
            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.message || "Không tìm thấy đường");
            }
            return await response.json();
        } catch (error) {
            console.error("[Pathfinding Error]:", error);
            throw error;
        }
    },

    async reloadMap(warehouseId) {
        try {
            const response = await fetch(`http://localhost:8082/debug/map-state/${warehouseId}/reload`, { method: 'POST' });
            return await response.json();
        } catch (error) {
            console.error("[Reload Map Error]:", error);
            throw error;
        }
    },

    async fetchDevices(warehouseId) {
        if (!warehouseId) return null;
        return this.callApi(`/warehouse/${warehouseId}/devices?limit=500`);
    },

    async fetchDeviceDetail(warehouseId, deviceId) {
        if (!warehouseId || !deviceId) return null;
        return this.callApi(`/warehouse/${warehouseId}/devices/${deviceId}`);
    },

    async updateDevice(warehouseId, deviceId, payload) {
        if (!warehouseId || !deviceId) return null;
        return this.callApi('/warehouse/' + warehouseId + '/devices/' + deviceId, {
            method: 'PUT',
            body: JSON.stringify(payload)
        });
    },

    async updateLocationStatus(warehouseId, locationId, status, isOccupied) {
        return this.callApi(`/warehouse/${warehouseId}/locations/${locationId}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ status, is_occupied: isOccupied })
        });
    },

    /**
     * Lấy danh sách device type
     */
    async fetchDeviceTypes() {
        return this.callApi(`/device-types?limit=100`);
    }
};