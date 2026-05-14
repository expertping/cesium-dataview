import * as Cesium from 'cesium'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TleInput {
  name?: string
  line1: string
  line2: string
}

export interface SatelliteConfig {
  name?: string
  tle: string | string[] | TleInput
  fovAlongDeg: number
  fovCrossDeg: number
  rollDeg?: number
  color?: Cesium.Color
  modelUrl?: string
  modelScale?: number
}

export interface OrbitFovOptions {
  satellites: SatelliteConfig[]
  startTime?: Date | string
  durationMinutes?: number
  stepSeconds?: number
  showOrbit?: boolean
  showFov?: boolean
  showGroundTrack?: boolean
  fovOpacity?: number
  orbitWidth?: number
  animationSpeed?: number
}

interface ParsedTle {
  name?: string
  line1: string
  line2: string
  epoch: Date
  inclinationRad: number
  raanRad: number
  eccentricity: number
  argPerigeeRad: number
  meanAnomalyRad: number
  meanMotionRadPerSecond: number
  semiMajorAxisMeters: number
}

interface SatelliteRuntime {
  config: SatelliteConfig
  parsedTle: ParsedTle
  positions: { time: Cesium.JulianDate; cartesian: Cesium.Cartesian3 }[]
  positionProperty: Cesium.SampledPositionProperty
  entities: Cesium.Entity[]
  rollDeg: number
  fovAlongDeg: number
  fovCrossDeg: number
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TWO_PI = Math.PI * 2
const SECONDS_PER_DAY = 86400
const MILLISECONDS_PER_DAY = 86400000
const JULIAN_DATE_UNIX_EPOCH = 2440587.5
const JULIAN_DATE_J2000 = 2451545.0
const EARTH_MU = 3.986004418e14
const KEPLER_EPSILON = 1e-12
const KEPLER_MAX_ITER = 15
const DEFAULT_COLORS = [
  Cesium.Color.CYAN,
  Cesium.Color.YELLOW,
  Cesium.Color.LIME,
  Cesium.Color.MAGENTA,
  Cesium.Color.ORANGE,
  Cesium.Color.DEEPSKYBLUE,
  Cesium.Color.RED,
  Cesium.Color.SPRINGGREEN
]

const DEFAULT_MODEL_URL = '/models/satellite.glb'

// ─── TLE Parsing (reused logic from useNadirPointDir) ────────────────────────

function parseTleInput(input: string | string[] | TleInput): TleInput {
  if (typeof input === 'object' && !Array.isArray(input)) {
    const line1 = input.line1?.trim()
    const line2 = input.line2?.trim()
    if (!line1 || !line2) throw new Error('TLE line1/line2 is required')
    return { name: input.name?.trim(), line1, line2 }
  }
  const lines = (Array.isArray(input) ? input : input.split(/\r?\n/))
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length < 2) throw new Error('TLE requires at least 2 lines')
  if (lines.length === 2) return { line1: lines[0]!, line2: lines[1]! }
  return { name: lines[0], line1: lines[1]!, line2: lines[2]! }
}

function parseTleEpoch(line1: string): Date {
  const year2 = Number(line1.slice(18, 20).trim())
  const dayOfYear = Number(line1.slice(20, 32).trim())
  const year = year2 >= 57 ? 1900 + year2 : 2000 + year2
  const startOfYear = Date.UTC(year, 0, 1, 0, 0, 0, 0)
  return new Date(startOfYear + (dayOfYear - 1) * MILLISECONDS_PER_DAY)
}

function parseTle(input: string | string[] | TleInput): ParsedTle {
  const { name, line1, line2 } = parseTleInput(input)
  const inclinationDeg = Number(line2.slice(8, 16).trim())
  const raanDeg = Number(line2.slice(17, 25).trim())
  const eccentricity = Number(`0.${line2.slice(26, 33).trim()}`)
  const argPerigeeDeg = Number(line2.slice(34, 42).trim())
  const meanAnomalyDeg = Number(line2.slice(43, 51).trim())
  const meanMotionRevPerDay = Number(line2.slice(52, 63).trim())

  const epoch = parseTleEpoch(line1)
  const meanMotionRadPerSecond = (meanMotionRevPerDay * TWO_PI) / SECONDS_PER_DAY
  const semiMajorAxisMeters = Math.cbrt(EARTH_MU / (meanMotionRadPerSecond ** 2))

  return {
    name, line1, line2, epoch,
    inclinationRad: Cesium.Math.toRadians(inclinationDeg),
    raanRad: Cesium.Math.toRadians(raanDeg),
    eccentricity,
    argPerigeeRad: Cesium.Math.toRadians(argPerigeeDeg),
    meanAnomalyRad: Cesium.Math.toRadians(meanAnomalyDeg),
    meanMotionRadPerSecond,
    semiMajorAxisMeters
  }
}

// ─── Orbital Mechanics ───────────────────────────────────────────────────────

function normalizeRadians(value: number): number {
  const m = value % TWO_PI
  return m < 0 ? m + TWO_PI : m
}

function solveKeplerEquation(M: number, e: number): number {
  let E = e < 0.8 ? M : Math.PI
  for (let i = 0; i < KEPLER_MAX_ITER; i++) {
    const delta = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E))
    E -= delta
    if (Math.abs(delta) < KEPLER_EPSILON) break
  }
  return E
}

function gmstRadians(date: Date): number {
  const jd = date.getTime() / MILLISECONDS_PER_DAY + JULIAN_DATE_UNIX_EPOCH
  const t = (jd - JULIAN_DATE_J2000) / 36525
  const gmstDeg = 280.46061837 + 360.98564736629 * (jd - JULIAN_DATE_J2000) +
    0.000387933 * t * t - (t * t * t) / 38710000
  return Cesium.Math.toRadians((((gmstDeg % 360) + 360) % 360))
}

function computeSatPositionEcef(tle: ParsedTle, time: Date): Cesium.Cartesian3 {
  const dt = (time.getTime() - tle.epoch.getTime()) / 1000
  const M = normalizeRadians(tle.meanAnomalyRad + tle.meanMotionRadPerSecond * dt)
  const E = solveKeplerEquation(M, tle.eccentricity)

  const cosE = Math.cos(E)
  const sinE = Math.sin(E)
  const sqrt1meSq = Math.sqrt(1 - tle.eccentricity * tle.eccentricity)

  const xOrb = tle.semiMajorAxisMeters * (cosE - tle.eccentricity)
  const yOrb = tle.semiMajorAxisMeters * sqrt1meSq * sinE

  const cosO = Math.cos(tle.raanRad), sinO = Math.sin(tle.raanRad)
  const cosI = Math.cos(tle.inclinationRad), sinI = Math.sin(tle.inclinationRad)
  const cosW = Math.cos(tle.argPerigeeRad), sinW = Math.sin(tle.argPerigeeRad)

  const xEci = xOrb * (cosO * cosW - sinO * sinW * cosI) - yOrb * (cosO * sinW + sinO * cosW * cosI)
  const yEci = xOrb * (sinO * cosW + cosO * sinW * cosI) + yOrb * (cosO * cosW * cosI - sinO * sinW)
  const zEci = xOrb * (sinW * sinI) + yOrb * (cosW * sinI)

  const gmst = gmstRadians(time)
  const cosG = Math.cos(gmst), sinG = Math.sin(gmst)
  return new Cesium.Cartesian3(
    cosG * xEci + sinG * yEci,
    -sinG * xEci + cosG * yEci,
    zEci
  )
}

// ─── FOV Geometry ────────────────────────────────────────────────────────────
function computeFovGroundCorners(
  satPosition: Cesium.Cartesian3,
  velocity: Cesium.Cartesian3,
  rollDeg: number,
  fovAlongDeg: number,
  fovCrossDeg: number
): Cesium.Cartesian3[] | null {
  const r = Cesium.Cartesian3.negate(satPosition, new Cesium.Cartesian3())
  Cesium.Cartesian3.normalize(r, r)

  const vNorm = Cesium.Cartesian3.normalize(velocity, new Cesium.Cartesian3())
  const crossDir = Cesium.Cartesian3.cross(vNorm, r, new Cesium.Cartesian3())
  Cesium.Cartesian3.normalize(crossDir, crossDir)

  const alongDir = Cesium.Cartesian3.cross(r, crossDir, new Cesium.Cartesian3())
  Cesium.Cartesian3.normalize(alongDir, alongDir)

  // Apply roll rotation around alongDir (Y-axis in body frame)
  const rollRad = Cesium.Math.toRadians(rollDeg)
  const rollQuat = Cesium.Quaternion.fromAxisAngle(alongDir, rollRad, new Cesium.Quaternion())
  const rollMatrix = Cesium.Matrix3.fromQuaternion(rollQuat, new Cesium.Matrix3())
  const nadirDir = Cesium.Matrix3.multiplyByVector(rollMatrix, r, new Cesium.Cartesian3())

  const halfAlong = Cesium.Math.toRadians(fovAlongDeg / 2)
  const halfCross = Cesium.Math.toRadians(fovCrossDeg / 2)

  const corners: Cesium.Cartesian3[] = []
  const signs: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]]

  for (const [sa, sc] of signs) {
    const rotAlong = Cesium.Quaternion.fromAxisAngle(crossDir, sa * halfAlong, new Cesium.Quaternion())
    const rotCross = Cesium.Quaternion.fromAxisAngle(alongDir, sc * halfCross, new Cesium.Quaternion())
    const combined = Cesium.Quaternion.multiply(rotCross, rotAlong, new Cesium.Quaternion())
    const mat = Cesium.Matrix3.fromQuaternion(combined, new Cesium.Matrix3())
    const rayDir = Cesium.Matrix3.multiplyByVector(mat, nadirDir, new Cesium.Cartesian3())

    const ray = new Cesium.Ray(satPosition, rayDir)
    const intersection = Cesium.IntersectionTests.rayEllipsoid(ray, Cesium.Ellipsoid.WGS84)
    if (!intersection) return null
    const point = Cesium.Ray.getPoint(ray, intersection.start, new Cesium.Cartesian3())
    corners.push(point)
  }

  return corners
}

function estimateVelocity(
  positions: { time: Cesium.JulianDate; cartesian: Cesium.Cartesian3 }[],
  currentTime: Cesium.JulianDate
): Cesium.Cartesian3 | null {
  if (positions.length < 2) return null

  const tSec = Cesium.JulianDate.secondsDifference(currentTime, positions[0].time)
  let idx = Math.floor(tSec / Cesium.JulianDate.secondsDifference(positions[1].time, positions[0].time))
  idx = Math.max(0, Math.min(idx, positions.length - 2))

  const p0 = positions[idx].cartesian
  const p1 = positions[idx + 1].cartesian
  const dt = Cesium.JulianDate.secondsDifference(positions[idx + 1].time, positions[idx].time)
  if (dt === 0) return null

  const vel = new Cesium.Cartesian3()
  Cesium.Cartesian3.subtract(p1, p0, vel)
  Cesium.Cartesian3.divideByScalar(vel, dt, vel)
  return vel
}

// ─── Main Hook ───────────────────────────────────────────────────────────────
export function useSatelliteOrbitFov(getViewer: () => Cesium.Viewer | null | undefined) {
  let satellites: SatelliteRuntime[] = []
  let originalClockSettings: {
    startTime: Cesium.JulianDate
    stopTime: Cesium.JulianDate
    currentTime: Cesium.JulianDate
    multiplier: number
    shouldAnimate: boolean
    clockRange: Cesium.ClockRange
  } | null = null

  const clearVisualization = () => {
    const viewer = getViewer()
    if (!viewer) return
    for (const sat of satellites) {
      for (const entity of sat.entities) {
        viewer.entities.remove(entity)
      }
    }
    satellites = []
    if (originalClockSettings) {
      viewer.clock.startTime = originalClockSettings.startTime.clone()
      viewer.clock.stopTime = originalClockSettings.stopTime.clone()
      viewer.clock.currentTime = originalClockSettings.currentTime.clone()
      viewer.clock.multiplier = originalClockSettings.multiplier
      viewer.clock.shouldAnimate = originalClockSettings.shouldAnimate
      viewer.clock.clockRange = originalClockSettings.clockRange
      originalClockSettings = null
    }
    viewer.scene.requestRender()
  }

  const startVisualization = (options: OrbitFovOptions) => {
    const viewer = getViewer()
    if (!viewer) return

    clearVisualization()

    const now = options.startTime
      ? (options.startTime instanceof Date ? options.startTime : new Date(options.startTime))
      : new Date()
    const durationMin = options.durationMinutes ?? 90
    const stepSec = options.stepSeconds ?? 30
    const showOrbit = options.showOrbit ?? true
    const showFov = options.showFov ?? true
    const showGround = options.showGroundTrack ?? true
    const fovOpacity = options.fovOpacity ?? 0.3
    const orbitWidth = options.orbitWidth ?? 2
    const speed = options.animationSpeed ?? 1

    const startJd = Cesium.JulianDate.fromDate(now)
    const stopJd = Cesium.JulianDate.addSeconds(startJd, durationMin * 60, new Cesium.JulianDate())

    // Save and configure clock
    originalClockSettings = {
      startTime: viewer.clock.startTime.clone(),
      stopTime: viewer.clock.stopTime.clone(),
      currentTime: viewer.clock.currentTime.clone(),
      multiplier: viewer.clock.multiplier,
      shouldAnimate: viewer.clock.shouldAnimate,
      clockRange: viewer.clock.clockRange
    }
    viewer.clock.startTime = startJd.clone()
    viewer.clock.stopTime = stopJd.clone()
    viewer.clock.currentTime = startJd.clone()
    viewer.clock.multiplier = speed
    viewer.clock.shouldAnimate = true
    viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP

    // Build each satellite
    options.satellites.forEach((config, index) => {
      const color = config.color ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length]
      const parsedTle = parseTle(config.tle)
      const rollDeg = config.rollDeg ?? 0
      const fovAlongDeg = config.fovAlongDeg
      const fovCrossDeg = config.fovCrossDeg
      const modelUrl = config.modelUrl ?? DEFAULT_MODEL_URL
      const modelScale = config.modelScale ?? 1

      // Precompute orbit positions
      const positions: { time: Cesium.JulianDate; cartesian: Cesium.Cartesian3 }[] = []
      const positionProperty = new Cesium.SampledPositionProperty()
      positionProperty.setInterpolationOptions({
        interpolationDegree: 5,
        interpolationAlgorithm: Cesium.LagrangePolynomialApproximation
      })

      const totalSec = durationMin * 60
      for (let s = 0; s <= totalSec; s += stepSec) {
        const t = new Date(now.getTime() + s * 1000)
        const jd = Cesium.JulianDate.fromDate(t)
        const pos = computeSatPositionEcef(parsedTle, t)
        positions.push({ time: jd, cartesian: pos })
        positionProperty.addSample(jd, pos)
      }

      const runtime: SatelliteRuntime = {
        config, parsedTle, positions, positionProperty,
        entities: [], rollDeg, fovAlongDeg, fovCrossDeg
      }

      const baseId = `satellite-${index}`
      const entities: Cesium.Entity[] = []

      // Model entity
      const modelEntity = viewer.entities.add({
        id: `${baseId}-model`,
        name: config.name ?? `Satellite ${index + 1}`,
        position: positionProperty,
        orientation: new Cesium.VelocityOrientationProperty(positionProperty),
        model: {
          uri: modelUrl,
          scale: modelScale,
          minimumPixelSize: 32
        },
        label: {
          text: config.name ?? `SAT-${index + 1}`,
          font: '12px sans-serif',
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          pixelOffset: new Cesium.Cartesian2(0, -24),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      })
      entities.push(modelEntity)
      // Orbit polyline
      if (showOrbit) {
        const orbitPositions = positions.map((p) => p.cartesian)
        const orbitEntity = viewer.entities.add({
          id: `${baseId}-orbit`,
          polyline: {
            positions: orbitPositions,
            width: orbitWidth,
            material: color.withAlpha(0.8),
            clampToGround: false
          }
        })
        entities.push(orbitEntity)
      }

      // FOV lines (4 edges from satellite to ground corners)
      if (showFov) {
        const fovLinesEntity = viewer.entities.add({
          id: `${baseId}-fov-lines`,
          polyline: {
            positions: new Cesium.CallbackProperty(() => {
              const currentTime = viewer.clock.currentTime
              const satPos = positionProperty.getValue(currentTime)
              if (!satPos) return []
              const vel = estimateVelocity(runtime.positions, currentTime)
              if (!vel) return []
              const corners = computeFovGroundCorners(
                satPos, vel, runtime.rollDeg, runtime.fovAlongDeg, runtime.fovCrossDeg
              )
              if (!corners) return []
              return [
                satPos, corners[0],
                satPos, corners[1],
                satPos, corners[2],
                satPos, corners[3]
              ]
            }, false) as any,
            width: 1,
            material: color.withAlpha(0.6)
          }
        })
        entities.push(fovLinesEntity)
      }

      // Ground coverage polygon
      if (showGround) {
        const groundEntity = viewer.entities.add({
          id: `${baseId}-fov-ground`,
          polygon: {
            hierarchy: new Cesium.CallbackProperty(() => {
              const currentTime = viewer.clock.currentTime
              const satPos = positionProperty.getValue(currentTime)
              if (!satPos) return new Cesium.PolygonHierarchy([])
              const vel = estimateVelocity(runtime.positions, currentTime)
              if (!vel) return new Cesium.PolygonHierarchy([])
              const corners = computeFovGroundCorners(
                satPos, vel, runtime.rollDeg, runtime.fovAlongDeg, runtime.fovCrossDeg
              )
              if (!corners) return new Cesium.PolygonHierarchy([])
              return new Cesium.PolygonHierarchy(corners)
            }, false) as any,
            material: color.withAlpha(fovOpacity),
            outline: true,
            outlineColor: color,
            outlineWidth: 1,
            perPositionHeight: false
          }
        })
        entities.push(groundEntity)
      }

      runtime.entities = entities
      satellites.push(runtime)
    })

    viewer.scene.requestRender()
  }

  const updateSatelliteParam = (
    index: number,
    param: Partial<Pick<SatelliteConfig, 'rollDeg' | 'fovAlongDeg' | 'fovCrossDeg'>>
  ) => {
    const sat = satellites[index]
    if (!sat) return
    if (param.rollDeg !== undefined) sat.rollDeg = param.rollDeg
    if (param.fovAlongDeg !== undefined) sat.fovAlongDeg = param.fovAlongDeg
    if (param.fovCrossDeg !== undefined) sat.fovCrossDeg = param.fovCrossDeg
  }

  const setAnimationSpeed = (multiplier: number) => {
    const viewer = getViewer()
    if (viewer) viewer.clock.multiplier = multiplier
  }

  const pauseAnimation = () => {
    const viewer = getViewer()
    if (viewer) viewer.clock.shouldAnimate = false
  }

  const resumeAnimation = () => {
    const viewer = getViewer()
    if (viewer) viewer.clock.shouldAnimate = true
  }

  const destroy = () => {
    clearVisualization()
  }

  return {
    startVisualization,
    updateSatelliteParam,
    setAnimationSpeed,
    pauseAnimation,
    resumeAnimation,
    clearVisualization,
    destroy
  }
}
