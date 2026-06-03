import { HEALTH_CHECK_CONFIG, ROUTE_TYPES } from './config.js';

const globalHealthCache = new Map();

export class EndpointHealthManager {
  getHealthKey(routeType, endpointIndex, baseUrlIndex) {
    return `${routeType}-${endpointIndex}-${baseUrlIndex}`;
  }

  async getHealth(endpointIndex, baseUrlIndex, routeType = ROUTE_TYPES.CLAUDE) {
    const key = this.getHealthKey(routeType, endpointIndex, baseUrlIndex);
    const health = globalHealthCache.get(key);

    if (!health) {
      return { failures: 0, lastFailTime: 0, inCooldown: false };
    }

    return health;
  }

  async saveHealth(endpointIndex, baseUrlIndex, health, routeType = ROUTE_TYPES.CLAUDE) {
    const key = this.getHealthKey(routeType, endpointIndex, baseUrlIndex);
    globalHealthCache.set(key, health);
  }

  async isAvailable(endpointIndex, baseUrlIndex, routeType = ROUTE_TYPES.CLAUDE) {
    const health = await this.getHealth(endpointIndex, baseUrlIndex, routeType);
    const now = Date.now();

    if (health.inCooldown) {
      if (now - health.lastFailTime >= HEALTH_CHECK_CONFIG.COOLDOWN_TIME * 1000) {
        return true;
      }
      return false;
    }

    return true;
  }

  async recordFailure(endpointIndex, baseUrlIndex, routeType = ROUTE_TYPES.CLAUDE) {
    const health = await this.getHealth(endpointIndex, baseUrlIndex, routeType);
    health.failures++;
    health.lastFailTime = Date.now();

    if (health.failures >= HEALTH_CHECK_CONFIG.MAX_FAILURES) {
      health.inCooldown = true;
    }

    await this.saveHealth(endpointIndex, baseUrlIndex, health, routeType);
  }

  async recordHardFailure(endpointIndex, baseUrlIndex, routeType = ROUTE_TYPES.CLAUDE) {
    await this.saveHealth(endpointIndex, baseUrlIndex, {
      failures: HEALTH_CHECK_CONFIG.MAX_FAILURES,
      lastFailTime: Date.now(),
      inCooldown: true
    }, routeType);
  }

  async recordSuccess(endpointIndex, baseUrlIndex, routeType = ROUTE_TYPES.CLAUDE) {
    const health = await this.getHealth(endpointIndex, baseUrlIndex, routeType);

    if (health.failures > 0 || health.inCooldown) {
      await this.saveHealth(endpointIndex, baseUrlIndex, {
        failures: 0,
        lastFailTime: 0,
        inCooldown: false
      }, routeType);
    }
  }
}
