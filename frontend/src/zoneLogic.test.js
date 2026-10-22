import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ADMIN_PASSWORD,
    DEFAULT_ZONE_RADIUS,
    MIN_ZONE_RADIUS,
    getZoneRadiusForSeconds,
    getZoneCenter,
    isAdminPasswordValid,
    resetZoneState
} from './zoneLogic.js';

test('zone starts at 600m and shrinks every 9 minutes', () => {
    const zone = resetZoneState({ lat: 51.513269, lng: -0.131 }, 45 * 60);
    assert.equal(zone.radius, DEFAULT_ZONE_RADIUS);
    assert.equal(getZoneRadiusForSeconds(45 * 60), DEFAULT_ZONE_RADIUS);
    assert.equal(getZoneRadiusForSeconds(36 * 60), 500);
    assert.equal(getZoneRadiusForSeconds(27 * 60), 400);
    assert.equal(getZoneRadiusForSeconds(18 * 60), 300);
    assert.equal(getZoneRadiusForSeconds(9 * 60), 200);
    assert.equal(getZoneRadiusForSeconds(0), 50);
});

test('admin GPS location is preserved as the zone center', () => {
    const adminLocation = { lat: 51.4999, lng: -0.1234 };
    const zone = resetZoneState(adminLocation, 45 * 60);

    assert.deepEqual(getZoneCenter(zone), adminLocation);
    assert.deepEqual(zone.center, adminLocation);
});

test('admin password gate only opens with the correct code', () => {
    assert.equal(isAdminPasswordValid(ADMIN_PASSWORD), true);
    assert.equal(isAdminPasswordValid('SONIYA'), true);
    assert.equal(isAdminPasswordValid('wrong-password'), false);
    assert.equal(isAdminPasswordValid(''), false);
});