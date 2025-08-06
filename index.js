const express = require("express")
const cors = require("cors")
const { createClient } = require("@supabase/supabase-js")
const { calculateRouteFromSegments } = require("./lib/routing")
require("dotenv").config()

const app = express()
const PORT = process.env.PORT || 3001

// Middleware
app.use(cors())
app.use(express.json())

// Validate environment variables
if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  console.error("❌ Error: NEXT_PUBLIC_SUPABASE_URL is required in .env file")
  process.exit(1)
}

if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  console.error("❌ Error: NEXT_PUBLIC_SUPABASE_ANON_KEY is required in .env file")
  process.exit(1)
}

// Supabase client
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)

// Global tracking state
const activeTrips = new Map()
const trackingIntervals = new Map()

// Utility functions
const calculateDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371 // Earth's radius in kilometers
  const dLat = toRadians(lat2 - lat1)
  const dLng = toRadians(lng2 - lng1)

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2)

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

const toRadians = (degrees) => degrees * (Math.PI / 180)

// Realistic speed calculation based on route type and conditions
const getRealisticSpeed = (distance, tripSegments) => {
  let baseSpeed
  
  // Check if route has toll segments
  const hasTollSegments = tripSegments && tripSegments.some(s => s.type === 'toll_entry' || s.type === 'toll_exit')
  
  if (hasTollSegments) {
    // Toll highways: 80-100 km/h as requested
    baseSpeed = Math.floor(Math.random() * (100 - 40 + 1)) + 40
  } else if (distance < 50) {
    // City routes: 25-40 km/h (traffic, stops)
    baseSpeed = Math.floor(Math.random() * (50 - 5 + 1)) + 5
  } else if (distance < 150) {
    // Inter-city routes: 45-65 km/h (mixed roads)
    baseSpeed = Math.floor(Math.random() * (50 - 20 + 1)) + 20
  } else {
    // Long distance routes: 60-80 km/h (highways with stops)
    baseSpeed = Math.floor(Math.random() * (80 - 20 + 1)) + 20
  }
  
  // Add random variation for traffic conditions (-10 to +5 km/h)
  const variation = Math.floor(Math.random() * 16) - 10
  return Math.max(20, Math.min(85, baseSpeed + variation)) // Keep within reasonable bounds
}

const formatElapsedTime = (minutes) => {
  const hours = Math.floor(minutes / 60)
  const mins = Math.floor(minutes % 60)

  if (hours > 0) {
    return `${hours}h${mins}m`
  }
  return `${mins}m`
}

// PERBAIKAN UTAMA: Enhanced tracking yang menggunakan route coordinates yang sudah ada
const startTripTracking = async (trip) => {
  console.log(`🚀 Starting SYNCHRONIZED backend tracking for trip: ${trip.id}`)

  // Stop existing tracking if any
  if (trackingIntervals.has(trip.id)) {
    clearInterval(trackingIntervals.get(trip.id))
  }

  // Get bus info
  const { data: bus } = await supabase.from("buses").select("*").eq("id", trip.bus_id).single()
  const tripName = bus?.nickname || trip.id.slice(0, 8)

  // PERBAIKAN UTAMA: Gunakan route coordinates yang sudah ada di trip, jangan hitung ulang
  let routeCoordinates = []
  let totalDistance = 0
  let estimatedDuration = trip.estimated_duration || 0

  if (trip.route && trip.route.length > 0) {
    // BAGUS: Gunakan route coordinates yang sudah tersimpan (sinkron dengan preview)
    routeCoordinates = trip.route
    totalDistance = trip.distance || 0
    console.log(`✅ Using SYNCHRONIZED route with ${routeCoordinates.length} points from trip database`)
  } else if (trip.segments && trip.segments.length > 0) {
    // Fallback: hitung route dari segments (hanya jika tidak ada route tersimpan)
    console.log(`⚠️ No route found in trip, calculating from segments...`)
    try {
      const routeData = await calculateRouteFromSegments(trip.segments)
      routeCoordinates = routeData.coordinates
      totalDistance = routeData.distance
      estimatedDuration = routeData.duration
      
      // Simpan route hasil perhitungan ke database untuk konsistensi
      await supabase
        .from("trips")
        .update({
          route: routeCoordinates,
          distance: totalDistance,
          estimated_duration: estimatedDuration,
        })
        .eq("id", trip.id)
        
      console.log(`📝 Route saved to database for future consistency`)
    } catch (routeError) {
      console.error(`❌ Route calculation failed for ${tripName}:`, routeError)
      // Emergency fallback
      routeCoordinates = [
        { lat: trip.departure.lat, lng: trip.departure.lng },
        { lat: trip.destination.lat, lng: trip.destination.lng }
      ]
      totalDistance = calculateDistance(trip.departure.lat, trip.departure.lng, trip.destination.lat, trip.destination.lng)
    }
  } else {
    // Ultimate fallback: direct line
    routeCoordinates = [
      { lat: trip.departure.lat, lng: trip.departure.lng },
      { lat: trip.destination.lat, lng: trip.destination.lng }
    ]
    totalDistance = calculateDistance(trip.departure.lat, trip.departure.lng, trip.destination.lat, trip.destination.lng)
    console.log(`🚨 Using emergency fallback route for ${tripName}`)
  }

  // Get realistic speed based on distance and segments
  const realisticSpeed = getRealisticSpeed(totalDistance, trip.segments)
  
  // Calculate realistic completion time in minutes
  const estimatedTripTimeMinutes = estimatedDuration || ((totalDistance / realisticSpeed) * 60)
  
  // Calculate progress per update (every 20 seconds for smooth movement)
  const updateIntervalSeconds = 20
  const totalUpdates = Math.ceil(estimatedTripTimeMinutes * 60 / updateIntervalSeconds)
  const progressPerUpdate = 100 / totalUpdates

  const speedType = trip.segments && trip.segments.some(s => s.type === 'toll_entry') ? 'toll route' : 'regular route'
  console.log(
    `📊 ${tripName}: Distance: ${totalDistance.toFixed(1)}km, Speed: ${realisticSpeed}km/h (${speedType}), Estimated time: ${estimatedTripTimeMinutes.toFixed(0)} minutes, Route points: ${routeCoordinates.length} (SYNCHRONIZED)`
  )

  const startTime = Date.now()
  let currentSpeed = realisticSpeed

  const interval = setInterval(async () => {
    try {
      // Get current trip data
      const { data: currentTrip, error } = await supabase.from("trips").select("*").eq("id", trip.id).single()

      if (error || !currentTrip || currentTrip.status !== "IN_PROGRESS") {
        console.log(`❌ ${tripName}: Trip not active, stopping tracking`)
        stopTripTracking(trip.id)
        return
      }

      // Calculate elapsed time in minutes
      const elapsedTimeMs = Date.now() - startTime
      const elapsedTimeMinutes = elapsedTimeMs / (1000 * 60)

      // Vary speed slightly for realism (+/- 5 km/h)
      const speedVariation = (Math.random() - 0.5) * 10
      currentSpeed = Math.max(15, Math.min(90, realisticSpeed + speedVariation))

      // Calculate new progress
      const newProgress = Math.min(100, currentTrip.progress + progressPerUpdate)

      // PERBAIKAN UTAMA: Calculate current position dari SYNCHRONIZED route coordinates
      let currentLat = currentTrip.current_lat
      let currentLng = currentTrip.current_lng

      if (routeCoordinates && Array.isArray(routeCoordinates) && routeCoordinates.length > 0) {
        const routeIndex = Math.floor((newProgress / 100) * (routeCoordinates.length - 1))
        const currentPosition = routeCoordinates[routeIndex] || routeCoordinates[0]
        currentLat = currentPosition.lat
        currentLng = currentPosition.lng
      }

      // Update trip progress
      const updates = {
        progress: newProgress,
        current_lat: currentLat,
        current_lng: currentLng,
        speed: Math.round(currentSpeed),
      }

      // If completed, mark as completed but keep bus at destination
      if (newProgress >= 100) {
        updates.status = "COMPLETED"
        updates.end_time = new Date().toISOString()
        console.log(`✅ ${tripName}: Trip completed using SYNCHRONIZED route - Bus staying at destination`)
        
        // Set bus as inactive but keep at destination
        await supabase.from("buses").update({ is_active: false }).eq("id", trip.bus_id)
      }

      // Update trip in database
      await supabase.from("trips").update(updates).eq("id", trip.id)

      // Update bus location for real-time tracking
      if (currentLat && currentLng) {
        // Delete old location first
        await supabase.from("bus_locations").delete().eq("bus_id", trip.bus_id)

        // Insert new location with elapsed time
        await supabase.from("bus_locations").insert({
          bus_id: trip.bus_id,
          trip_id: trip.id,
          lat: currentLat,
          lng: currentLng,
          progress: newProgress,
          elapsed_time_minutes: elapsedTimeMinutes,
          timestamp: Date.now(),
        })
      }

      // If completed, keep bus at destination (don't remove location)
      if (newProgress >= 100) {
        console.log(`🏁 ${tripName}: Bus parked at destination using SYNCHRONIZED route - ${trip.destination.name}`)
        stopTripTracking(trip.id)
      }

      console.log(
        `📊 ${tripName}: ${newProgress.toFixed(1)}% (${formatElapsedTime(elapsedTimeMinutes)}) - ${currentSpeed.toFixed(0)}km/h (SYNCHRONIZED route)`
      )
    } catch (error) {
      console.error(`❌ Error tracking ${tripName}:`, error)
    }
  }, updateIntervalSeconds * 1000) // Update every 20 seconds

  trackingIntervals.set(trip.id, interval)
  activeTrips.set(trip.id, { ...trip, speed: realisticSpeed, startTime, totalDistance, estimatedTime: estimatedTripTimeMinutes })
}

// Stop tracking a trip
const stopTripTracking = (tripId) => {
  const interval = trackingIntervals.get(tripId)
  if (interval) {
    clearInterval(interval)
    trackingIntervals.delete(tripId)
    activeTrips.delete(tripId)
    console.log(`🛑 Stopped tracking trip: ${tripId.slice(0, 8)}`)
  }
}

// Enhanced initialization with bus positioning
const initializeTracking = async () => {
  console.log("🔄 Initializing SYNCHRONIZED backend tracking system...")

  try {
    // Test Supabase connection first
    const { data: testData, error: testError } = await supabase.from("buses").select("count").limit(1)

    if (testError) {
      console.error("❌ Supabase connection failed:", testError.message)
      return
    }

    console.log("✅ Supabase connection successful")

    // Load in-progress trips
    const { data: inProgressTrips, error } = await supabase.from("trips").select("*").eq("status", "IN_PROGRESS")

    if (error) {
      console.error("❌ Error loading in-progress trips:", error)
      return
    }

    if (inProgressTrips && inProgressTrips.length > 0) {
      console.log(`🚀 Found ${inProgressTrips.length} in-progress trips, starting SYNCHRONIZED tracking...`)

      for (const trip of inProgressTrips) {
        await startTripTracking(trip)
      }
    } else {
      console.log("✅ No in-progress trips found")
    }

    // Position buses for pending trips at departure locations
    const { data: pendingTrips, error: pendingError } = await supabase.from("trips").select("*").eq("status", "PENDING")
    
    if (!pendingError && pendingTrips && pendingTrips.length > 0) {
      console.log(`📍 Positioning ${pendingTrips.length} buses at departure locations...`)
      
      for (const trip of pendingTrips) {
        try {
          // Position bus at departure location
          await supabase.from("bus_locations").delete().eq("bus_id", trip.bus_id)
          await supabase.from("bus_locations").insert({
            bus_id: trip.bus_id,
            trip_id: trip.id,
            lat: trip.departure.lat,
            lng: trip.departure.lng,
            progress: 0,
            elapsed_time_minutes: 0,
            timestamp: Date.now(),
          })
          console.log(`📍 Bus positioned at departure: ${trip.departure.name}`)
        } catch (positionError) {
          console.error("Error positioning bus:", positionError)
        }
      }
    }

  } catch (error) {
    console.error("❌ Error initializing SYNCHRONIZED tracking:", error)
  }
}

// API Routes
app.get("/api/health", (req, res) => {
  const activeTripsArray = Array.from(activeTrips.values()).map((trip) => ({
    id: trip.id,
    speed: trip.speed,
    distance: trip.totalDistance,
    estimatedTime: trip.estimatedTime,
    elapsedMinutes: (Date.now() - trip.startTime) / (1000 * 60),
  }))

  res.json({
    status: "OK",
    activeTrips: activeTrips.size,
    timestamp: new Date().toISOString(),
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ? "✅ Configured" : "❌ Missing",
    supabaseKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "✅ Configured" : "❌ Missing",
    trackingMode: "SYNCHRONIZED Route Preview (25-85 km/h) + Destination Parking",
    updateInterval: "20 seconds",
    trips: activeTripsArray,
  })
})

app.post("/api/trips/:tripId/start", async (req, res) => {
  try {
    const { tripId } = req.params

    // Get trip data
    const { data: trip, error } = await supabase.from("trips").select("*").eq("id", tripId).single()

    if (error || !trip) {
      return res.status(404).json({ error: "Trip not found" })
    }

    // Update trip status
    await supabase
      .from("trips")
      .update({
        status: "IN_PROGRESS",
        start_time: new Date().toISOString(),
      })
      .eq("id", tripId)

    // Update bus status
    await supabase.from("buses").update({ is_active: true }).eq("id", trip.bus_id)

    // Start SYNCHRONIZED tracking
    await startTripTracking({ ...trip, status: "IN_PROGRESS" })

    res.json({ 
      success: true, 
      message: "Trip started with SYNCHRONIZED route tracking",
      trackingMode: "Using exact same route as preview + destination parking enabled"
    })
  } catch (error) {
    console.error("Error starting trip:", error)
    res.status(500).json({ error: "Failed to start trip" })
  }
})

app.post("/api/trips/:tripId/cancel", async (req, res) => {
  try {
    const { tripId } = req.params

    // Get trip data
    const { data: trip, error } = await supabase.from("trips").select("*").eq("id", tripId).single()

    if (error || !trip) {
      return res.status(404).json({ error: "Trip not found" })
    }

    // Stop tracking
    stopTripTracking(tripId)

    // Update trip status
    await supabase
      .from("trips")
      .update({
        status: "CANCELLED",
        end_time: new Date().toISOString(),
      })
      .eq("id", tripId)

    // Update bus status and remove location (return to garage)
    await supabase.from("buses").update({ is_active: false }).eq("id", trip.bus_id)
    await supabase.from("bus_locations").delete().eq("bus_id", trip.bus_id)

    res.json({ success: true, message: "Trip cancelled - Bus returned to garage" })
  } catch (error) {
    console.error("Error cancelling trip:", error)
    res.status(500).json({ error: "Failed to cancel trip" })
  }
})

app.get("/api/trips/active", (req, res) => {
  const activeTripsArray = Array.from(activeTrips.values()).map((trip) => ({
    id: trip.id,
    bus_id: trip.bus_id,
    speed: trip.speed,
    totalDistance: trip.totalDistance,
    estimatedTime: trip.estimatedTime,
    startTime: trip.startTime,
    elapsedMinutes: (Date.now() - trip.startTime) / (1000 * 60),
  }))

  res.json(activeTripsArray)
})

// Enhanced real-time subscriptions
const setupRealtimeSubscriptions = () => {
  console.log("📡 Setting up SYNCHRONIZED real-time subscriptions...")

  // Listen for trip changes with bus positioning
  supabase
    .channel("backend_trips")
    .on("postgres_changes", { event: "*", schema: "public", table: "trips" }, async (payload) => {
      console.log("🗺️ Backend trip change:", payload.eventType, payload.new?.id || payload.old?.id)

      if (payload.eventType === "UPDATE") {
        const trip = payload.new

        if (trip.status === "IN_PROGRESS" && !activeTrips.has(trip.id)) {
          console.log("🆕 New trip to track with SYNCHRONIZED route:", trip.id.slice(0, 8))
          await startTripTracking(trip)
        } else if (trip.status !== "IN_PROGRESS" && activeTrips.has(trip.id)) {
          console.log("🛑 Trip no longer in progress:", trip.id.slice(0, 8))
          stopTripTracking(trip.id)
        }
      } else if (payload.eventType === "INSERT") {
        const trip = payload.new
        
        // Position bus at departure for new pending trips
        if (trip.status === "PENDING") {
          try {
            await supabase.from("bus_locations").delete().eq("bus_id", trip.bus_id)
            await supabase.from("bus_locations").insert({
              bus_id: trip.bus_id,
              trip_id: trip.id,
              lat: trip.departure.lat,
              lng: trip.departure.lng,
              progress: 0,
              elapsed_time_minutes: 0,
              timestamp: Date.now(),
            })
            console.log(`📍 New trip: Bus positioned at ${trip.departure.name}`)
          } catch (positionError) {
            console.error("Error positioning bus for new trip:", positionError)
          }
        }
      }
    })
    .subscribe((status) => {
      console.log("📡 Backend trips subscription:", status)
    })
}

// Start server
app.listen(PORT, async () => {
  console.log(`🚀 SYNCHRONIZED Bus Tracking Backend Server running on port ${PORT}`)
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`)
  console.log(`🔧 Environment:`)
  console.log(`   - Supabase URL: ${process.env.NEXT_PUBLIC_SUPABASE_URL ? "✅ Configured" : "❌ Missing"}`)
  console.log(`   - Supabase Key: ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "✅ Configured" : "❌ Missing"}`)
  console.log(`🚌 Tracking Mode: SYNCHRONIZED Route Preview (25-85 km/h) + Destination Parking`)
  console.log(`⏱️ Update Interval: 20 seconds for optimal real-time experience`)
  console.log(`🛣️ Routing: Uses EXACT same route coordinates as preview (no recalculation)`)

  // Initialize SYNCHRONIZED tracking and subscriptions
  await initializeTracking()
  setupRealtimeSubscriptions()

  console.log("✅ SYNCHRONIZED backend tracking system ready!")
})

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("🛑 Shutting down SYNCHRONIZED backend server...")

  // Clear all intervals
  trackingIntervals.forEach((interval) => clearInterval(interval))
  trackingIntervals.clear()
  activeTrips.clear()

  console.log("✅ SYNCHRONIZED backend server stopped")
  process.exit(0)
})