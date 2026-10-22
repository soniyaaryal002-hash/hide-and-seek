import { io } from 'socket.io-client';
import './styles.css';
import {
    DEFAULT_ZONE_CENTER,
    DEFAULT_ZONE_RADIUS,
    DEFAULT_ROUND_SECONDS,
    getZoneCenter,
    getZoneRadiusForSeconds,
    isAdminPasswordValid,
    normalizeZoneCenter,
    resetZoneState,
    shouldCompressDataUrl
} from './zoneLogic.js';

const pingSchedule = [
    { label: 'Scatter', minutes: 0, radius: '800 m', interval: '�' },
    { label: '0�15', minutes: 15, radius: '800 m', interval: '5 min' },
    { label: '15�25', minutes: 25, radius: '600?450 m', interval: '5 min' },
    { label: '25�45', minutes: 45, radius: '450?300 m', interval: '5 min' },
    { label: '45�65', minutes: 65, radius: '300?200 m', interval: '5 min' },
    { label: '65�85', minutes: 85, radius: '120?80 m', interval: '5 min' },
    { label: '85�100', minutes: 100, radius: '50 m', interval: '2 min' }
];

const PHOTO_CLUE_REMINDER_SECONDS = [
    45 * 60 - 10 * 60,
    45 * 60 - 20 * 60,
    45 * 60 - 30 * 60,
    45 * 60 - 40 * 60,
    45 * 60 - 50 * 60
];

const LOCATION_REVEAL_SECONDS = [
    45 * 60 - 5 * 60,
    45 * 60 - 10 * 60,
    45 * 60 - 15 * 60,
    45 * 60 - 20 * 60,
    45 * 60 - 25 * 60,
    45 * 60 - 30 * 60,
    45 * 60 - 35 * 60,
    45 * 60 - 40 * 60,
    45 * 60 - 45 * 60
];
const LOCATION_REVEAL_MS = 45 * 1000;

const state = {
    started: false,
    totalSeconds: DEFAULT_ROUND_SECONDS,
    pingIndex: 0,
    lastBuzz: '�',
    lastPhotoReminderSeconds: null,
    lastLocationRevealSeconds: null,
    locationRevealUntil: 0,
    players: [],
    socket: null,
    roomCode: '',
    myName: '',
    pendingJoin: false,
    timerId: null,
    boundaryRadius: DEFAULT_ZONE_RADIUS,
    teams: [],
    photoClues: [],
    seekerTeam: 'Red',
    locationWatchId: null,
    currentLocation: null,
    mapMarkers: new Map(),
    adminLocationMarker: null,
    reminderPulseLayer: null,
    seekerUnlocked: false,
    adminUnlocked: false,
    zone: { center: null, radius: DEFAULT_ZONE_RADIUS, roundSeconds: DEFAULT_ROUND_SECONDS }
};

const countdownEl = document.getElementById('countdown');
const hidersLeftEl = document.getElementById('hiders-left');
const seekersCountEl = document.getElementById('seekers-count');
const phaseNameEl = document.getElementById('phase-name');
const radiusValueEl = document.getElementById('radius-value');
const zoneStatEl = document.getElementById('zone-stat');
const lastBuzzEl = document.getElementById('last-buzz');
const yourRoleEl = document.getElementById('your-role');
const yourRoleMetaEl = document.getElementById('your-role-meta');
const seekerTeamSelect = document.getElementById('seeker-team-select');
const playersListEl = document.getElementById('team-list');
const seekerPlayerListEl = document.getElementById('seeker-player-list');
const pingScheduleEl = document.getElementById('ping-schedule');
const killFeedEl = document.getElementById('kill-feed');
const startGameButton = document.getElementById('start-game');
const triggerPingButton = document.getElementById('trigger-ping');
const photoButton = document.getElementById('drop-photo');
const markFoundButton = document.getElementById('mark-found');
const foundPlayerSelect = document.getElementById('found-player-select');
const joinRoomButton = document.getElementById('join-room');
const roomCodeInput = document.getElementById('room-code');
const playerNameInput = document.getElementById('player-name');
const teamSelect = document.getElementById('team-select');
const zoneLatInput = document.getElementById('zone-lat');
const zoneLngInput = document.getElementById('zone-lng');
const zoneCenterLabelEl = document.getElementById('zone-center-label');
const setAdminZoneButton = document.getElementById('set-admin-zone');
const resetZoneButton = document.getElementById('reset-zone');
const adminPasswordInput = document.getElementById('admin-password');
const unlockAdminButton = document.getElementById('unlock-admin');
const adminControlsEl = document.getElementById('admin-controls');
const adminLockMessageEl = document.getElementById('admin-lock-message');
const endRoundButton = document.getElementById('end-round');

const backendUrl =
    import.meta.env.VITE_BACKEND_URL || 'https://hide-and-seek-backend-bshf.onrender.com';
const mapCenter = [DEFAULT_ZONE_CENTER.lat, DEFAULT_ZONE_CENTER.lng];
let map;
let boundaryLayer;

function formatTime(totalSeconds) {
    const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

function getBoundaryRadius() {
    return getZoneRadiusForSeconds(state.totalSeconds, DEFAULT_ROUND_SECONDS, 50);
}

function setAdminAccessState(isUnlocked) {
    state.adminUnlocked = isUnlocked;

    if (adminControlsEl) {
        adminControlsEl.classList.toggle('hidden', !isUnlocked);
    }

    if (setAdminZoneButton) {
        setAdminZoneButton.disabled = !isUnlocked;
    }

    if (resetZoneButton) {
        resetZoneButton.disabled = !isUnlocked;
    }

    if (seekerTeamSelect) {
        seekerTeamSelect.disabled = !isUnlocked;
    }

    if (adminLockMessageEl) {
        const message = isUnlocked ?
            'Admin unlocked. GPS, the boundary reset, and the seeker team are now active.' :
            'Enter the admin password to use GPS, reset the boundary, and choose the seeker team.';
        adminLockMessageEl.textContent = message;
        adminLockMessageEl.classList.toggle('error', false);
    }
}

function unlockAdminZone() {
    const passwordValue = adminPasswordInput ? adminPasswordInput.value : '';

    if (!isAdminPasswordValid(passwordValue)) {
        if (adminLockMessageEl) {
            adminLockMessageEl.textContent = 'Incorrect password. Only the admin can use the zone controls.';
            adminLockMessageEl.classList.toggle('error', true);
        }
        return;
    }

    setAdminAccessState(true);
    if (adminPasswordInput) {
        adminPasswordInput.value = '';
    }
}

function getTeamColor(teamName) {
    if (teamName === 'Red') return '#d65042';
    if (teamName === 'Blue') return '#355bdb';
    if (teamName === 'Green') return '#2d8a6d';
    return '#f39c12';
}

function normalizeTeamName(teamName) {
    const value = String(teamName || '').trim();
    if (!value) return 'Unassigned';

    const match = ['Red', 'Blue', 'Green', 'Yellow'].find((team) => team.toLowerCase() === value.toLowerCase());
    return match || 'Unassigned';
}

function getPlayerGroups() {
    const groups = new Map();
    const orderedTeams = ['Red', 'Blue', 'Green', 'Yellow'];

    state.players.forEach((player) => {
        const teamName = normalizeTeamName(player.team);
        if (!groups.has(teamName)) {
            groups.set(teamName, []);
        }
        groups.get(teamName).push(player);
    });

    return orderedTeams.map((teamName) => {
        const players = groups.get(teamName) || [];

        return {
            name: teamName,
            players: players.map((player) => ({
                name: player.name,
                role: player.role || 'Hider'
            }))
        };
    });
}

function initMap() {
    if (map) return;

    const initialCenter = state.zone && state.zone.center ? [state.zone.center.lat, state.zone.center.lng] : mapCenter;

    map = L.map('board-map', {
        zoomControl: false,
        attributionControl: true,
        scrollWheelZoom: true,
        dragging: true,
        doubleClickZoom: false,
        tap: false,
    }).setView(initialCenter, 15);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
        crossOrigin: true
    }).addTo(map);

    setTimeout(() => {
        if (map) {
            map.invalidateSize();
            map.setView(initialCenter, 15);
        }
    }, 250);

    if (state.zone && state.zone.center) {
        boundaryLayer = L.circle([state.zone.center.lat, state.zone.center.lng], {
            radius: state.zone.radius,
            color: state.started ? '#d94d4d' : '#18b56a',
            weight: 4,
            fillColor: state.started ? '#d94d4d' : '#18b56a',
            fillOpacity: state.started ? 0.18 : 0.12,
            dashArray: '7 10'
        }).addTo(map);

        const spawnMarker = L.circleMarker([state.zone.center.lat, state.zone.center.lng], {
            radius: 7,
            color: '#f39c12',
            fillColor: '#ffd36d',
            fillOpacity: 1
        }).addTo(map);

        spawnMarker.bindPopup('Rally point');
        map.fitBounds([
            [state.zone.center.lat - 0.005, state.zone.center.lng - 0.01],
            [state.zone.center.lat + 0.005, state.zone.center.lng + 0.01]
        ]);
    }
}

function updateZoneDisplay() {
    if (!state.zone || !state.zone.center) {
        if (zoneCenterLabelEl) {
            zoneCenterLabelEl.textContent = 'Not set yet';
        }
        if (zoneLatInput) {
            zoneLatInput.value = '';
        }
        if (zoneLngInput) {
            zoneLngInput.value = '';
        }
        if (boundaryLayer && map) {
            map.removeLayer(boundaryLayer);
            boundaryLayer = null;
        }
        if (map) {
            map.setView([DEFAULT_ZONE_CENTER.lat, DEFAULT_ZONE_CENTER.lng], 15);
        }
        return;
    }

    const center = getZoneCenter(state.zone);
    const nextRadius = getBoundaryRadius();
    state.zone.center = center;
    state.zone.radius = nextRadius;

    if (zoneCenterLabelEl) {
        zoneCenterLabelEl.textContent = `${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`;
    }

    if (zoneLatInput) {
        zoneLatInput.value = center.lat.toFixed(6);
    }

    if (zoneLngInput) {
        zoneLngInput.value = center.lng.toFixed(6);
    }

    const ringColor = state.started ? '#d94d4d' : '#18b56a';

    if (!boundaryLayer && map) {
        boundaryLayer = L.circle([center.lat, center.lng], {
            radius: nextRadius,
            color: ringColor,
            weight: 4,
            fillColor: ringColor,
            fillOpacity: state.started ? 0.2 : 0.18,
            dashArray: '7 10'
        }).addTo(map);
    }

    if (boundaryLayer) {
        boundaryLayer.setLatLng([center.lat, center.lng]);
        boundaryLayer.setRadius(nextRadius);
        boundaryLayer.setStyle({
            color: ringColor,
            fillColor: ringColor,
            fillOpacity: state.started ? 0.2 : 0.18,
            weight: 4,
            dashArray: '7 10'
        });
    }

    if (map) {
        map.setView([center.lat, center.lng], Math.max(map.getZoom(), 15));
    }

    const radiusText = `${Math.round(nextRadius)} m`;
    radiusValueEl.textContent = radiusText;
    if (zoneStatEl) {
        zoneStatEl.textContent = radiusText;
    }
}

function updateBoundary() {
    updateZoneDisplay();
}

function isLocationRevealActive() {
    return Date.now() < state.locationRevealUntil;
}

function triggerLocationReveal() {
    state.locationRevealUntil = Date.now() + LOCATION_REVEAL_MS;

    if (state.zone && state.zone.center && map) {
        if (state.reminderPulseLayer) {
            map.removeLayer(state.reminderPulseLayer);
        }

        state.reminderPulseLayer = L.circle([state.zone.center.lat, state.zone.center.lng], {
            radius: 40,
            color: '#2d9bf0',
            fillColor: '#2d9bf0',
            fillOpacity: 0.12,
            weight: 3,
            dashArray: '6 8'
        }).addTo(map);

        setTimeout(() => {
            if (state.reminderPulseLayer && map) {
                map.removeLayer(state.reminderPulseLayer);
                state.reminderPulseLayer = null;
            }
        }, 4500);
    }

    state.photoClues.unshift({
        id: `reveal-${Date.now()}`,
        team: 'System',
        caption: 'Everyone’s locations are visible for 45 seconds.',
        image: null,
        createdAt: Date.now()
    });
    renderFeed();
}

function checkLocationReveal() {
    if (!state.started || !Number.isFinite(state.totalSeconds)) {
        return;
    }

    const hasReveal = LOCATION_REVEAL_SECONDS.includes(state.totalSeconds);
    if (!hasReveal) {
        return;
    }

    if (state.lastLocationRevealSeconds === state.totalSeconds) {
        return;
    }

    state.lastLocationRevealSeconds = state.totalSeconds;
    triggerLocationReveal();
}

function renderMapMarkers() {
    if (!map) return;

    state.mapMarkers.forEach((marker) => map.removeLayer(marker));
    state.mapMarkers.clear();

    if (state.zone && state.zone.center) {
        if (!state.adminLocationMarker) {
            state.adminLocationMarker = L.circleMarker([state.zone.center.lat, state.zone.center.lng], {
                radius: 8,
                color: '#f39c12',
                fillColor: '#ffd36d',
                fillOpacity: 1,
                weight: 3
            }).addTo(map);
        }

        state.adminLocationMarker.setLatLng([state.zone.center.lat, state.zone.center.lng]);
        state.adminLocationMarker.bindPopup('Admin GPS zone centre');
    } else if (state.adminLocationMarker) {
        map.removeLayer(state.adminLocationMarker);
        state.adminLocationMarker = null;
    }

    const revealMode = isLocationRevealActive();

    const playersWithLocations = state.players.filter((player) => player.location);
    playersWithLocations.forEach((player) => {
        const isCurrentUser = Boolean(state.socket && state.socket.id && player.id === state.socket.id);
        const marker = L.circleMarker([player.location.lat, player.location.lng], {
            radius: revealMode ? (isCurrentUser ? 10 : 9) : (isCurrentUser ? 8 : player.role === 'Seeker' ? 9 : 7),
            color: isCurrentUser ? '#2158d0' : getTeamColor(player.team || 'Red'),
            fillColor: isCurrentUser ? '#6fa8ff' : (player.role === 'Seeker' ? '#ff5a5f' : '#9fe3a6'),
            fillOpacity: 1,
            weight: revealMode ? 3 : 2
        }).addTo(map);

        marker.bindPopup(`
            <strong>${player.name}</strong><br>
            ${player.team || 'Unassigned'} • ${player.role || 'Hider'}<br>
            ${player.location.lat.toFixed(5)}, ${player.location.lng.toFixed(5)}
        `);

        state.mapMarkers.set(player.id, marker);
    });

    const currentPlayer = state.players.find((player) => state.socket && state.socket.id && player.id === state.socket.id);
    const isCurrentUserVisible = currentPlayer && currentPlayer.location;

    if (state.currentLocation && !isCurrentUserVisible) {
        const selfMarker = L.circleMarker([state.currentLocation.lat, state.currentLocation.lng], {
            radius: revealMode ? 10 : 8,
            color: '#2158d0',
            fillColor: '#6fa8ff',
            fillOpacity: 1,
            weight: revealMode ? 3 : 2
        }).addTo(map);
        selfMarker.bindPopup('Your GPS location');
        state.mapMarkers.set('self-location', selfMarker);
    }
}

function syncFoundPlayerSelect() {
    if (!foundPlayerSelect) return;

    const previousValue = foundPlayerSelect.value;
    const hiddenPlayers = (state.players || []).filter((player) => player.role !== 'Seeker');

    foundPlayerSelect.innerHTML = '<option value="">Select found hider</option>';

    if (!hiddenPlayers.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No hiders left';
        option.disabled = true;
        foundPlayerSelect.appendChild(option);
        return;
    }

    hiddenPlayers.forEach((player) => {
        const option = document.createElement('option');
        option.value = player.id;
        option.textContent = `${player.name} (${player.team || 'Team'})`;
        foundPlayerSelect.appendChild(option);
    });

    if (previousValue && hiddenPlayers.some((player) => player.id === previousValue)) {
        foundPlayerSelect.value = previousValue;
    }
}

function syncSeekerTeamSelect() {
    if (!seekerTeamSelect) return;
    const nextValue = ['Red', 'Blue', 'Green', 'Yellow'].includes(state.seekerTeam) ? state.seekerTeam : 'Red';
    state.seekerTeam = nextValue;
    seekerTeamSelect.value = nextValue;
}

function updateYourRoleCard() {
    const myPlayer = (state.players || []).find((player) => {
        if (state.socket && state.socket.id && player.id === state.socket.id) return true;
        return player.name === state.myName;
    });

    if (!myPlayer) {
        if (yourRoleEl) {
            yourRoleEl.textContent = 'Waiting';
            yourRoleEl.className = 'role-badge waiting';
        }
        if (yourRoleMetaEl) {
            yourRoleMetaEl.textContent = 'Join room to sync';
        }
        return;
    }

    const role = myPlayer.role || 'Hider';
    const label = role === 'Seeker' ? 'Seeker' : 'Hider';
    const teamLabel = myPlayer.team ? `Team ${myPlayer.team}` : 'Unassigned team';

    if (yourRoleEl) {
        yourRoleEl.textContent = label;
        yourRoleEl.className = `role-badge ${label.toLowerCase()}`;
    }

    if (yourRoleMetaEl) {
        yourRoleMetaEl.textContent = teamLabel;
    }
}

function renderPlayers() {
    playersListEl.innerHTML = '';
    state.teams = getPlayerGroups();

    if (!state.teams.length) {
        playersListEl.innerHTML = '<div class="empty-state">No players in this room yet. Join with a room code to sync live teams.</div>';
        hidersLeftEl.textContent = '0';
        seekersCountEl.textContent = '0';
        syncFoundPlayerSelect();
        updateYourRoleCard();
        return;
    }

    state.teams.forEach((team) => {
                const teamCard = document.createElement('div');
                const teamClass = `team-${team.name.toLowerCase()}`;
                const isSeekerTeam = state.started && state.seekerTeam === team.name;
                teamCard.className = `team-card ${teamClass}`;

                let members = '';
                if (team.players.length) {
                    members = team.players.map((member) => {
                        const isSeekerMember = member.role === 'Seeker';
                        return `<span class="team-member ${isSeekerMember ? 'seeker-member' : ''}">${member.name}${isSeekerMember ? ' • Seeker' : ''}</span>`;
                    }).join('');
                } else {
                    members = '<span class="team-member empty">No players yet</span>';
                }

                teamCard.innerHTML = `
            <div class="team-topline">
                <strong>${team.name}</strong>
                <span class="player-role role-${team.name.toLowerCase()}">${isSeekerTeam ? 'Seeker team' : `${team.players.length} players`}</span>
            </div>
            <div class="team-members">${members}</div>
        `;
        playersListEl.appendChild(teamCard);
    });

    const hiders = state.players.filter((player) => player.role !== 'Seeker').length;
    const seekers = state.players.filter((player) => player.role === 'Seeker').length;
    hidersLeftEl.textContent = String(hiders);
    seekersCountEl.textContent = String(seekers);
    syncFoundPlayerSelect();
    updateYourRoleCard();
}

function renderSchedule() {
    if (!pingScheduleEl) return;

    pingScheduleEl.innerHTML = '';
    pingSchedule.forEach((step) => {
        const item = document.createElement('div');
        item.className = 'timeline-item';
        item.innerHTML = `
      <strong>${step.label}</strong>
      <span>Radius: ${step.radius}</span>
      <small>Interval: ${step.interval}</small>
    `;
        pingScheduleEl.appendChild(item);
    });
}

function renderFeed() {
    const feedEntries = state.photoClues
        .map((clue) => {
            const hasImage = Boolean(clue && clue.image);
            let caption = '';
            if (clue && clue.caption) {
                caption = clue.caption;
            }
            return {
                type: hasImage ? 'photo' : 'note',
                text: hasImage ?
                    `${clue.team} dropped a photo clue.` : `${clue.team} • ${clue.caption || 'Game update'}`,
                image: hasImage ? clue.image : null,
                caption: caption
            };
        })
        .slice(0, 7);

    killFeedEl.innerHTML = '';
    feedEntries.forEach((entry) => {
        const li = document.createElement('li');

        if (entry.type === 'photo') {
            li.innerHTML = `
                <div>${entry.text}</div>
                <img src="${entry.image}" alt="Photo clue" style="width: 100%; max-height: 180px; object-fit: cover; border-radius: 10px; margin-top: 8px;" />
                <small style="display:block; margin-top: 6px; color: #5a6479;">${entry.caption}</small>
            `;
        } else {
            li.textContent = entry.text;
        }

        killFeedEl.appendChild(li);
    });
}

function updatePhaseName() {
    const phase = pingSchedule[state.pingIndex];
    phaseNameEl.textContent = phase ? phase.label : 'Endgame';
    radiusValueEl.textContent = phase ? phase.radius : '50 m';
}

function triggerPhotoClueReminder() {
    const reminderText = 'Hiders: drop a photo clue for the seekers now.';
    const reminder = {
        id: `photo-reminder-${Date.now()}`,
        team: 'System',
        caption: reminderText,
        image: null,
        createdAt: Date.now()
    };

    if (state.zone && state.zone.center && map) {
        if (state.reminderPulseLayer) {
            map.removeLayer(state.reminderPulseLayer);
        }

        state.reminderPulseLayer = L.circle([state.zone.center.lat, state.zone.center.lng], {
            radius: 35,
            color: '#ee4d4d',
            fillColor: '#ee4d4d',
            fillOpacity: 0.18,
            weight: 3,
            dashArray: '8 10'
        }).addTo(map);

        setTimeout(() => {
            if (state.reminderPulseLayer && map) {
                map.removeLayer(state.reminderPulseLayer);
                state.reminderPulseLayer = null;
            }
        }, 4000);
    }

    state.photoClues.unshift(reminder);
    renderFeed();
}

function checkPhotoClueReminder() {
    if (!state.started || !Number.isFinite(state.totalSeconds)) {
        return;
    }

    const hasReminder = PHOTO_CLUE_REMINDER_SECONDS.includes(state.totalSeconds);
    if (!hasReminder) {
        return;
    }

    if (state.lastPhotoReminderSeconds === state.totalSeconds) {
        return;
    }

    state.lastPhotoReminderSeconds = state.totalSeconds;
    triggerPhotoClueReminder();
}

function triggerPing() {
    const phase = pingSchedule[state.pingIndex];
    state.lastBuzz = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    lastBuzzEl.textContent = state.lastBuzz;

    const circles = document.querySelectorAll('.ping-circle');
    circles.forEach((circle, idx) => {
        const baseRadius = 56 + idx * 8;
        circle.setAttribute('r', Math.max(18, baseRadius * (state.pingIndex / 6 + 0.4)));
        circle.style.opacity = '1';
    });

    const headline = phase ? `Game alert: ${phase.label}` : 'Game alert';
    const pingEntry = headline;
    state.photoClues.unshift({
        id: `ping-${Date.now()}`,
        team: 'Game',
        caption: pingEntry,
        image: null,
        createdAt: Date.now()
    });
    renderFeed();

    state.pingIndex = Math.min(state.pingIndex + 1, pingSchedule.length - 1);
    updatePhaseName();
}

function stopTimer() {
    if (state.timerId) {
        clearInterval(state.timerId);
        state.timerId = null;
    }
}

function startTimer() {
    stopTimer();
    state.started = true;
    countdownEl.textContent = formatTime(state.totalSeconds);
    updateBoundary();

    state.timerId = setInterval(() => {
        if (!state.started) {
            return;
        }

        if (state.totalSeconds > 0) {
            state.totalSeconds -= 1;
            countdownEl.textContent = formatTime(state.totalSeconds);
            checkPhotoClueReminder();
            checkLocationReveal();
            updateBoundary();
        } else {
            state.started = false;
            stopTimer();
            phaseNameEl.textContent = 'Finished';
            radiusValueEl.textContent = '50 m';
        }
    }, 1000);
}

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function compressPhotoForRoom(dataUrl, maxBytes = 1_000_000) {
    if (!shouldCompressDataUrl(dataUrl, maxBytes)) {
        return dataUrl;
    }

    const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = dataUrl;
    });

    const maxWidth = 1200;
    const widthScale = Math.min(1, maxWidth / Math.max(image.width, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * widthScale));
    canvas.height = Math.max(1, Math.round(image.height * widthScale));
    const context = canvas.getContext('2d');

    if (!context) {
        return dataUrl;
    }

    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    let quality = 0.72;
    let nextDataUrl = canvas.toDataURL('image/jpeg', quality);

    while (shouldCompressDataUrl(nextDataUrl, maxBytes) && quality > 0.35) {
        quality -= 0.1;
        nextDataUrl = canvas.toDataURL('image/jpeg', quality);
    }

    return nextDataUrl;
}

function dropPhotoClue() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';

    fileInput.addEventListener('change', async(event) => {
        const files = event.target.files || [];
        const file = files[0];
        if (!file) return;

        const dataUrl = await fileToDataUrl(file);
        const compressedDataUrl = await compressPhotoForRoom(dataUrl, 1_000_000);
        const clue = {
            id: `photo-${Date.now()}`,
            team: state.seekerTeam || 'Red',
            caption: 'Photo clue dropped for the team',
            image: compressedDataUrl,
            createdAt: Date.now()
        };

        state.photoClues = [clue, ...state.photoClues].slice(0, 5);
        renderFeed();

        if (state.socket) {
            state.socket.emit('photo:drop', {
                roomCode: state.roomCode,
                team: clue.team,
                image: clue.image,
                caption: clue.caption
            });
        }
    });

    fileInput.click();
}

function markFoundPlayer() {
    const selectedPlayerId = foundPlayerSelect ? foundPlayerSelect.value : '';
    const available = (state.players || []).filter((player) => player.role !== 'Seeker');

    if (!available.length) {
        state.photoClues.unshift({
            id: `found-${Date.now()}`,
            team: 'Game',
            caption: 'No active hidden player left to convert.',
            image: null,
            createdAt: Date.now()
        });
        renderFeed();
        return;
    }

    const target = selectedPlayerId ?
        available.find((player) => player.id === selectedPlayerId) || available[0] :
        available[0];

    if (!target) return;

    target.role = 'Seeker';
    state.seekerTeam = target.team || state.seekerTeam;

    if (state.socket) {
        state.socket.emit('player:found', {
            roomCode: state.roomCode,
            playerId: target.id
        });
    }

    state.photoClues.unshift({
        id: `found-${Date.now()}`,
        team: target.team || 'Game',
        caption: `${target.name} has been found and moved to the seeker team.`,
        image: null,
        createdAt: Date.now()
    });

    if (foundPlayerSelect) {
        foundPlayerSelect.value = '';
    }

    renderFeed();
    renderPlayers();
    renderMapMarkers();
}

function endCurrentRound() {
    stopTimer();
    state.started = false;
    state.lastPhotoReminderSeconds = null;
    state.lastLocationRevealSeconds = null;
    state.locationRevealUntil = 0;
    state.pingIndex = 0;
    state.photoClues = [];
    state.zone = { center: null, radius: DEFAULT_ZONE_RADIUS, roundSeconds: DEFAULT_ROUND_SECONDS };

    if (state.socket && state.roomCode) {
        state.socket.emit('end-round', { roomCode: state.roomCode });
    }

    countdownEl.textContent = formatTime(DEFAULT_ROUND_SECONDS);
    phaseNameEl.textContent = 'Finished';
    radiusValueEl.textContent = '—';
    updateBoundary();
    renderFeed();
}

function watchLocation() {
    if (!navigator.geolocation) {
        state.photoClues.unshift({
            id: `gps-${Date.now()}`,
            team: 'System',
            caption: 'Geolocation is not available on this browser.',
            image: null,
            createdAt: Date.now()
        });
        renderFeed();
        return;
    }

    const sendLocation = ({ coords }) => {
        const payload = {
            lat: coords.latitude,
            lng: coords.longitude,
            accuracy: coords.accuracy || 0
        };

        state.currentLocation = payload;

        if (state.socket && state.roomCode) {
            state.socket.emit('location:update', payload);
        }
    };

    state.locationWatchId = navigator.geolocation.watchPosition(sendLocation, () => {}, {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 60000
    });
}

function syncRoomState(snapshot = {}) {
    const nextPlayers = Array.isArray(snapshot.players) ? snapshot.players : state.players;
    state.players = nextPlayers;
    state.roomCode = snapshot.roomCode || state.roomCode;

    if (typeof snapshot.started === 'boolean') {
        state.started = snapshot.started;
    }

    if (snapshot.zone) {
        state.zone = {
            ...state.zone,
            center: snapshot.zone.center ? normalizeZoneCenter(snapshot.zone.center) : null,
            radius: Number.isFinite(Number(snapshot.zone.radius)) ? Number(snapshot.zone.radius) : DEFAULT_ZONE_RADIUS,
            roundSeconds: Number.isFinite(Number(snapshot.zone.roundSeconds)) ? Number(snapshot.zone.roundSeconds) : DEFAULT_ROUND_SECONDS,
        };
    }

    if (snapshot.gameState) {
        if (typeof snapshot.gameState.started === 'boolean') {
            state.started = snapshot.gameState.started;
        }
        if (snapshot.gameState.seekerTeam) {
            state.seekerTeam = snapshot.gameState.seekerTeam;
        }
        syncSeekerTeamSelect();

        if (typeof snapshot.gameState.timerSeconds === 'number' && snapshot.gameState.timerSeconds >= 0) {
            state.totalSeconds = snapshot.gameState.timerSeconds;
        } else {
            state.totalSeconds = DEFAULT_ROUND_SECONDS;
        }

        if (!state.started) {
            stopTimer();
        }

        countdownEl.textContent = formatTime(state.totalSeconds);
        phaseNameEl.textContent = snapshot.gameState.phase || 'Scatter';
        checkPhotoClueReminder();
        checkLocationReveal();
    } else {
        state.totalSeconds = DEFAULT_ROUND_SECONDS;
        countdownEl.textContent = formatTime(state.totalSeconds);
    }

    if (Array.isArray(snapshot.clues)) {
        state.photoClues = snapshot.clues.slice(0, 5);
    }

    if (!snapshot.zone && !state.zone.center) {
        state.zone = { center: null, radius: DEFAULT_ZONE_RADIUS, roundSeconds: DEFAULT_ROUND_SECONDS };
    }

    updateBoundary();
    renderPlayers();
    renderMapMarkers();
    renderFeed();
    updateYourRoleCard();
}

function updateMyTeamAssignment() {
    if (!state.socket || !state.roomCode) return;

    state.socket.emit('player:assign', {
        roomCode: state.roomCode,
        playerId: state.socket.id,
        team: teamSelect.value || 'Red'
    });
}

function setAdminZoneFromGPS() {
    if (!state.adminUnlocked) {
        unlockAdminZone();
        return;
    }

    const manualLatText = (zoneLatInput && zoneLatInput.value !== undefined ? zoneLatInput.value : '').trim();
    const manualLngText = (zoneLngInput && zoneLngInput.value !== undefined ? zoneLngInput.value : '').trim();

    let center = null;

    if (manualLatText !== '' && manualLngText !== '') {
        const manualLatitude = Number(manualLatText);
        const manualLongitude = Number(manualLngText);

        if (Number.isFinite(manualLatitude) && Number.isFinite(manualLongitude)) {
            center = {
                lat: manualLatitude,
                lng: manualLongitude
            };
        }
    }

    if (!center && state.currentLocation) {
        const currentLat = Number(state.currentLocation.lat);
        const currentLng = Number(state.currentLocation.lng);
        if (Number.isFinite(currentLat) && Number.isFinite(currentLng)) {
            center = {
                lat: currentLat,
                lng: currentLng
            };
        }
    }

    if (center) {
        state.zone = {
            center: normalizeZoneCenter(center),
            radius: DEFAULT_ZONE_RADIUS,
            roundSeconds: DEFAULT_ROUND_SECONDS
        };

        if (state.socket && state.roomCode) {
            state.socket.emit('zone:update', {
                roomCode: state.roomCode,
                center: state.zone.center,
                radius: state.zone.radius,
                reset: true
            });
        }
        state.zone = {
            center: normalizeZoneCenter(state.zone.center),
            radius: DEFAULT_ZONE_RADIUS,
            roundSeconds: DEFAULT_ROUND_SECONDS
        };
        updateBoundary();
        return;
    }

    if (!navigator.geolocation) {
        state.photoClues.unshift({
            id: `gps-zone-${Date.now()}`,
            team: 'System',
            caption: 'Geolocation is not available in this browser.',
            image: null,
            createdAt: Date.now()
        });
        renderFeed();
        return;
    }

    navigator.geolocation.getCurrentPosition(function handlePosition(position) {
        const nextCenter = {
            lat: position.coords.latitude,
            lng: position.coords.longitude
        };

        state.currentLocation = nextCenter;
        state.zone = {
            center: normalizeZoneCenter(nextCenter),
            radius: DEFAULT_ZONE_RADIUS,
            roundSeconds: DEFAULT_ROUND_SECONDS
        };

        if (state.socket && state.roomCode) {
            state.socket.emit('zone:update', {
                roomCode: state.roomCode,
                center: state.zone.center,
                radius: state.zone.radius,
                reset: true
            });
        }
        updateBoundary();
    }, function handleError() {
        state.photoClues.unshift({
            id: `gps-zone-${Date.now()}`,
            team: 'System',
            caption: 'Unable to access the admin location from GPS right now.',
            image: null,
            createdAt: Date.now()
        });
        renderFeed();
    }, {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 60000
    });
}

function resetCurrentRoundZone() {
    if (!state.adminUnlocked) {
        unlockAdminZone();
        return;
    }

    stopTimer();
    state.started = false;
    state.totalSeconds = DEFAULT_ROUND_SECONDS;
    state.lastPhotoReminderSeconds = null;
    state.lastLocationRevealSeconds = null;
    state.locationRevealUntil = 0;
    state.pingIndex = 0;
    phaseNameEl.textContent = 'Scatter';
    radiusValueEl.textContent = '600 m';
    countdownEl.textContent = formatTime(state.totalSeconds);
    state.zone = { center: null, radius: DEFAULT_ZONE_RADIUS, roundSeconds: DEFAULT_ROUND_SECONDS };

    if (state.socket && state.roomCode) {
        state.socket.emit('reset-round', { roomCode: state.roomCode });
    }

    updateBoundary();
    renderFeed();
}

function connectSocket() {
    const socket = io(backendUrl, { transports: ['websocket', 'polling'] });
    state.socket = socket;
    stopTimer();
    state.started = false;
    state.totalSeconds = DEFAULT_ROUND_SECONDS;
    state.lastPhotoReminderSeconds = null;
    countdownEl.textContent = formatTime(state.totalSeconds);

    socket.on('connect', function handleConnect() {
        if (state.pendingJoin) {
            const name = playerNameInput.value.trim() || `Player ${Math.floor(Math.random() * 900 + 100)}`;
            const roomCode = 'SONIYA';
            if (roomCodeInput) {
                roomCodeInput.value = roomCode;
            }
            const selectedTeam = teamSelect.value || 'Red';
            state.roomCode = roomCode;
            state.myName = name;
            state.started = false;
            state.totalSeconds = DEFAULT_ROUND_SECONDS;
            state.lastPhotoReminderSeconds = null;
            countdownEl.textContent = formatTime(state.totalSeconds);
            socket.emit('join-room', {
                roomCode,
                name,
                team: selectedTeam
            });
            state.pendingJoin = false;
            watchLocation();
        }
    });

    socket.on('room:update', function handleRoomUpdate(payload) {
        syncRoomState(payload);
    });

    socket.on('ping:triggered', function handlePing(payload) {
        if (payload && payload.phase) {
            phaseNameEl.textContent = payload.phase;
            radiusValueEl.textContent = payload.phase === 'Scatter' ? '800 m' : 'Ping';
        }
        triggerPing();
    });

    socket.on('round:paused', function handleRoundPaused() {
        stopTimer();
        state.started = false;
        state.lastPhotoReminderSeconds = null;
        phaseNameEl.textContent = 'Paused';
        radiusValueEl.textContent = '—';
        countdownEl.textContent = formatTime(state.totalSeconds);
    });

    socket.on('round:ended', function handleRoundEnded() {
        stopTimer();
        state.started = false;
        state.totalSeconds = DEFAULT_ROUND_SECONDS;
        state.lastPhotoReminderSeconds = null;
        state.pingIndex = 0;
        countdownEl.textContent = formatTime(state.totalSeconds);
        phaseNameEl.textContent = 'Finished';
        radiusValueEl.textContent = '—';
        renderFeed();
    });

    socket.on('photo:drop', function handlePhotoDrop(clue) {
        if (!clue) return;

        const nextClues = [clue, ...state.photoClues.filter((entry) => entry && entry.id !== clue.id)].slice(0, 5);
        state.photoClues = nextClues;
        renderFeed();
    });
}

function joinRoom() {
    const name = playerNameInput.value.trim() || `Player ${Math.floor(Math.random() * 900 + 100)}`;
    const roomCode = 'SONIYA';
    if (roomCodeInput) {
        roomCodeInput.value = roomCode;
    }

    stopTimer();
    state.started = false;
    state.totalSeconds = DEFAULT_ROUND_SECONDS;
    state.lastPhotoReminderSeconds = null;
    state.pingIndex = 0;
    state.myName = name;
    state.roomCode = roomCode;
    countdownEl.textContent = formatTime(state.totalSeconds);

    if (!state.socket) {
        state.pendingJoin = true;
        connectSocket();
        return;
    }

    state.socket.emit('join-room', {
        roomCode: state.roomCode,
        name: state.myName,
        team: teamSelect.value || 'Red'
    });
}

startGameButton.addEventListener('click', function onStartGame() {
    if (!state.socket || !state.roomCode) {
        return;
    }

    if (!state.zone || !state.zone.center || !Number.isFinite(state.zone.center.lat) || !Number.isFinite(state.zone.center.lng)) {
        return;
    }

    if (seekerTeamSelect && seekerTeamSelect.value) {
        state.seekerTeam = seekerTeamSelect.value;
    }

    state.socket.emit('start-game', { roomCode: state.roomCode, seekerTeam: state.seekerTeam });

    state.started = true;
    state.lastPhotoReminderSeconds = null;
    state.pingIndex = 0;
    if (!Number.isFinite(state.totalSeconds) || state.totalSeconds <= 0) {
        state.totalSeconds = DEFAULT_ROUND_SECONDS;
    }
    countdownEl.textContent = formatTime(state.totalSeconds);

    startTimer();
    updateBoundary();
});

triggerPingButton.addEventListener('click', function onPing() {
    if (state.socket) {
        state.socket.emit('trigger-ping', { roomCode: state.roomCode });
    }
    triggerPing();
});

photoButton.addEventListener('click', dropPhotoClue);
markFoundButton.addEventListener('click', markFoundPlayer);
joinRoomButton.addEventListener('click', joinRoom);
teamSelect.addEventListener('change', updateMyTeamAssignment);
if (seekerTeamSelect) {
    seekerTeamSelect.addEventListener('change', function handleSeekerTeamChange() {
        if (!state.adminUnlocked) {
            seekerTeamSelect.value = state.seekerTeam || 'Red';
            unlockAdminZone();
            return;
        }
        state.seekerTeam = seekerTeamSelect.value || 'Red';
    });
}

if (unlockAdminButton) {
    unlockAdminButton.addEventListener('click', unlockAdminZone);
}

if (adminPasswordInput) {
    adminPasswordInput.addEventListener('keydown', function handlePasswordKeydown(event) {
        if (event.key === 'Enter') {
            unlockAdminZone();
        }
    });
}

if (setAdminZoneButton) {
    setAdminZoneButton.addEventListener('click', setAdminZoneFromGPS);
}

if (resetZoneButton) {
    resetZoneButton.addEventListener('click', resetCurrentRoundZone);
}

endRoundButton.addEventListener('click', endCurrentRound);
syncSeekerTeamSelect();
setAdminAccessState(false);
renderPlayers();
renderSchedule();
renderFeed();
updateBoundary();
countdownEl.textContent = formatTime(state.totalSeconds);
updatePhaseName();
countdownEl.textContent = formatTime(state.totalSeconds);
renderPlayers();
updateBoundary();
initMap();
connectSocket();