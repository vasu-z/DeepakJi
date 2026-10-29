/**
 * Saarthi Real-Time GPS Location Service.
 *
 * Implements actual foreground device location tracking using expo-location.
 *
 * Safety & Reliability Rules:
 * - Never invent current coordinates or use a hardcoded location as user position.
 * - Accuracy gating: Reports horizontal accuracy (meters) and categorizes fix quality.
 * - Stale fix detection: Flags location updates older than 15 seconds.
 * - High accuracy for navigation: Uses Accuracy.BestForNavigation with sensible intervals (1.5s, 2m).
 * - Full cleanup: Cleans up watchPositionAsync subscriptions on stop and unmount.
 */

import type { LocationObject, LocationSubscription } from "expo-location";

let LocationModule: any = null;
try {
  LocationModule = require("expo-location");
} catch {
  LocationModule = null;
}

const Location = LocationModule;

export type GpsAccuracyLevel = "excellent" | "good" | "moderate" | "poor" | "unusable" | "lost";

export interface RealGpsLocation {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  altitudeMeters: number | null;
  headingDegrees: number | null;
  speedMetersPerSec: number | null;
  timestamp: number;
  isStale: boolean;
  accuracyLevel: GpsAccuracyLevel;
}

export interface LocationPermissionStatus {
  granted: boolean;
  canAskAgain: boolean;
  servicesEnabled: boolean;
  errorMessage?: string;
}

export interface LocationDiagnostics {
  permissionGranted: boolean;
  servicesEnabled: boolean;
  isWatching: boolean;
  lastFixTimestamp: number | null;
  accuracyMeters: number | null;
  accuracyLevel: GpsAccuracyLevel;
  latitude: number | null;
  longitude: number | null;
  isStale: boolean;
  fixCount: number;
}

export type LocationCallback = (location: RealGpsLocation) => void;
export type DiagnosticsCallback = (diagnostics: LocationDiagnostics) => void;

// Campus center for Chandigarh University (used SOLELY as initial camera/map viewport, NEVER as user position)
export const CU_CAMPUS_VIEWPORT_CENTER = {
  latitude: 30.76864,
  longitude: 76.57505,
  latitudeDelta: 0.008,
  longitudeDelta: 0.008,
};

export class LocationService {
  private subscription: any = null;
  private lastLocation: RealGpsLocation | null = null;
  private locationListeners: Set<LocationCallback> = new Set();
  private diagnosticsListeners: Set<DiagnosticsCallback> = new Set();
  private fixCount: number = 0;
  private stalenessCheckTimer: any = null;

  constructor() {
    this.startStalenessMonitor();
  }

  /**
   * Evaluate horizontal accuracy into accessible qualitative levels.
   */
  public evaluateAccuracy(accuracyMeters: number): GpsAccuracyLevel {
    if (accuracyMeters <= 5) return "excellent";
    if (accuracyMeters <= 10) return "good";
    if (accuracyMeters <= 20) return "moderate";
    if (accuracyMeters <= 35) return "poor";
    return "unusable";
  }

  /**
   * Check if location services (GPS hardware) are enabled on the device.
   */
  public async checkServicesEnabled(): Promise<boolean> {
    if (!Location) return false;
    try {
      return await Location.hasServicesEnabledAsync();
    } catch {
      return false;
    }
  }

  /**
   * Request foreground location permission with accessible reason.
   */
  public async requestPermissions(): Promise<LocationPermissionStatus> {
    if (!Location) {
      return {
        granted: false,
        canAskAgain: false,
        servicesEnabled: false,
        errorMessage: "Location hardware module is not available on this device build.",
      };
    }
    try {
      const servicesEnabled = await this.checkServicesEnabled();
      if (!servicesEnabled) {
        return {
          granted: false,
          canAskAgain: true,
          servicesEnabled: false,
          errorMessage: "Device location services (GPS) are turned off. Please enable Location in phone Settings.",
        };
      }

      const { status, canAskAgain } = await Location.getForegroundPermissionsAsync();
      if (status === Location.PermissionStatus?.GRANTED || status === "granted") {
        return { granted: true, canAskAgain, servicesEnabled: true };
      }

      const requested = await Location.requestForegroundPermissionsAsync();
      const granted = requested.status === Location.PermissionStatus?.GRANTED || requested.status === "granted";

      return {
        granted,
        canAskAgain: requested.canAskAgain,
        servicesEnabled: true,
        errorMessage: granted ? undefined : "Location permission was denied. SAARTHI cannot provide real outdoor GPS navigation without location access.",
      };
    } catch (err: any) {
      return {
        granted: false,
        canAskAgain: true,
        servicesEnabled: false,
        errorMessage: `Failed to request location permission: ${err?.message || "Unknown error"}`,
      };
    }
  }

  /**
   * Acquire a one-shot current location fix.
   * Throws or returns null if fix cannot be acquired. Never hallucinates coordinates.
   */
  public async getCurrentLocation(timeoutMs: number = 10000): Promise<RealGpsLocation | null> {
    const perm = await this.requestPermissions();
    if (!perm.granted) {
      throw new Error(perm.errorMessage || "Location permission not granted.");
    }

    try {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
        timeInterval: 1000,
      });

      const fix = this.transformExpoPosition(pos);
      this.lastLocation = fix;
      this.fixCount++;
      this.notifyListeners(fix);
      return fix;
    } catch (err: any) {
      throw new Error(`Location fix timed out or unavailable: ${err?.message || "GPS signal weak"}`);
    }
  }

  /**
   * Start live GPS position tracking for active navigation.
   * Uses high-accuracy outdoor settings with time/distance filters to prevent GPS jump jitter.
   */
  public async startWatchingLocation(
    onLocation: LocationCallback,
    onDiagnostics?: DiagnosticsCallback
  ): Promise<LocationPermissionStatus> {
    if (onDiagnostics) {
      this.diagnosticsListeners.add(onDiagnostics);
    }
    this.locationListeners.add(onLocation);

    // If already watching, immediately emit the latest known fix
    if (this.subscription) {
      if (this.lastLocation) {
        onLocation(this.lastLocation);
      }
      this.emitDiagnostics();
      return { granted: true, canAskAgain: true, servicesEnabled: true };
    }

    const perm = await this.requestPermissions();
    if (!perm.granted) {
      this.emitDiagnostics();
      return perm;
    }

    try {
      this.subscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 1500, // 1.5 seconds between fixes
          distanceInterval: 2, // 2 meters movement threshold
        },
        (pos: LocationObject) => {
          const fix = this.transformExpoPosition(pos);
          this.lastLocation = fix;
          this.fixCount++;
          this.notifyListeners(fix);
          this.emitDiagnostics();
        }
      );

      this.emitDiagnostics();
      return { granted: true, canAskAgain: true, servicesEnabled: true };
    } catch (err: any) {
      this.subscription = null;
      this.emitDiagnostics();
      return {
        granted: false,
        canAskAgain: true,
        servicesEnabled: true,
        errorMessage: `Failed to start GPS tracking: ${err?.message || "Unknown error"}`,
      };
    }
  }

  /**
   * Stop active GPS watching subscription and cleanup resources.
   */
  public stopWatchingLocation(callbackToRemove?: LocationCallback): void {
    if (callbackToRemove) {
      this.locationListeners.delete(callbackToRemove);
    }

    // If no more listeners remain, unsubscribe hardware
    if (this.locationListeners.size === 0 && this.subscription) {
      this.subscription.remove();
      this.subscription = null;
      this.emitDiagnostics();
    }
  }

  /**
   * Unconditionally stop and release all subscriptions (for screen unmount).
   */
  public stopAll(): void {
    if (this.subscription) {
      this.subscription.remove();
      this.subscription = null;
    }
    if (this.stalenessCheckTimer) {
      clearInterval(this.stalenessCheckTimer);
      this.stalenessCheckTimer = null;
    }
    this.locationListeners.clear();
    this.emitDiagnostics();
  }

  public getLastKnownLocation(): RealGpsLocation | null {
    if (!this.lastLocation) return null;
    const isStale = Date.now() - this.lastLocation.timestamp > 15000;
    return { ...this.lastLocation, isStale };
  }

  public getDiagnostics(): LocationDiagnostics {
    const isStale = this.lastLocation ? Date.now() - this.lastLocation.timestamp > 15000 : true;
    return {
      permissionGranted: true,
      servicesEnabled: true,
      isWatching: Boolean(this.subscription),
      lastFixTimestamp: this.lastLocation?.timestamp || null,
      accuracyMeters: this.lastLocation?.accuracyMeters || null,
      accuracyLevel: this.lastLocation ? (isStale ? "lost" : this.lastLocation.accuracyLevel) : "lost",
      latitude: this.lastLocation?.latitude || null,
      longitude: this.lastLocation?.longitude || null,
      isStale,
      fixCount: this.fixCount,
    };
  }

  private transformExpoPosition(pos: LocationObject): RealGpsLocation {
    const acc = pos.coords.accuracy ?? 99.0;
    const isStale = Date.now() - pos.timestamp > 15000;
    return {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracyMeters: Math.round(acc * 10) / 10,
      altitudeMeters: pos.coords.altitude !== null ? Math.round(pos.coords.altitude * 10) / 10 : null,
      headingDegrees: pos.coords.heading !== null ? Math.round(pos.coords.heading) : null,
      speedMetersPerSec: pos.coords.speed !== null ? Math.max(0, Math.round(pos.coords.speed * 10) / 10) : null,
      timestamp: pos.timestamp,
      isStale,
      accuracyLevel: isStale ? "lost" : this.evaluateAccuracy(acc),
    };
  }

  private notifyListeners(fix: RealGpsLocation): void {
    for (const listener of this.locationListeners) {
      try {
        listener(fix);
      } catch {
        // Safe isolate
      }
    }
  }

  private emitDiagnostics(): void {
    const diag = this.getDiagnostics();
    for (const listener of this.diagnosticsListeners) {
      try {
        listener(diag);
      } catch {
        // Safe isolate
      }
    }
  }

  private startStalenessMonitor(): void {
    if (this.stalenessCheckTimer) return;
    this.stalenessCheckTimer = setInterval(() => {
      if (this.subscription && this.lastLocation) {
        const isStaleNow = Date.now() - this.lastLocation.timestamp > 15000;
        if (isStaleNow !== this.lastLocation.isStale) {
          this.lastLocation = {
            ...this.lastLocation,
            isStale: isStaleNow,
            accuracyLevel: isStaleNow ? "lost" : this.evaluateAccuracy(this.lastLocation.accuracyMeters),
          };
          this.notifyListeners(this.lastLocation);
          this.emitDiagnostics();
        }
      }
    }, 5000);
    if (this.stalenessCheckTimer && typeof this.stalenessCheckTimer.unref === "function") {
      this.stalenessCheckTimer.unref();
    }
  }
}

export const locationService = new LocationService();
