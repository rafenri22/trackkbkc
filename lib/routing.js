// Backend routing functionality menggunakan OSRM API
const fetch = require('node-fetch');

const OSRM_BASE_URL = "https://router.project-osrm.org";

// Calculate distance using Haversine formula
const calculateDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const toRadians = (degrees) => degrees * (Math.PI / 180);

// Validate coordinates
const isValidCoordinate = (lat, lng) => {
  return !isNaN(lat) && !isNaN(lng) && 
         isFinite(lat) && isFinite(lng) &&
         lat >= -90 && lat <= 90 && 
         lng >= -180 && lng <= 180 &&
         (lat !== 0 || lng !== 0); // Exclude null island
};

// Get route from OSRM API with enhanced error handling
const getRouteFromOSRM = async (startPoint, endPoint) => {
  try {
    console.log(`🛣️ Backend: Getting OSRM route from ${startPoint.name} to ${endPoint.name}`);
    
    // Validate coordinates first
    if (!isValidCoordinate(startPoint.lat, startPoint.lng) || 
        !isValidCoordinate(endPoint.lat, endPoint.lng)) {
      console.warn('Backend: Invalid coordinates, falling back to direct route');
      return getDirectRoute(startPoint, endPoint);
    }
    
    // Format coordinates for OSRM (lng,lat)
    const coordinates = `${startPoint.lng},${startPoint.lat};${endPoint.lng},${endPoint.lat}`;
    const url = `${OSRM_BASE_URL}/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=true`;
    
    console.log(`📡 Backend OSRM API URL: ${url}`);
    
    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    const response = await fetch(url, { 
      signal: controller.signal 
    }).finally(() => clearTimeout(timeoutId));
    
    if (!response.ok) {
      console.warn(`Backend OSRM API failed (${response.status}), falling back to direct route`);
      return getDirectRoute(startPoint, endPoint);
    }
    
    const data = await response.json();
    
    if (!data.routes || data.routes.length === 0) {
      console.warn('Backend: No routes found from OSRM, falling back to direct route');
      return getDirectRoute(startPoint, endPoint);
    }
    
    const route = data.routes[0];
    const geometry = route.geometry;
    
    // Convert GeoJSON coordinates to our format
    const routeCoordinates = geometry.coordinates.map(coord => ({
      lat: coord[1], // GeoJSON uses [lng, lat]
      lng: coord[0]
    }));
    
    const distanceKm = route.distance / 1000; // Convert meters to kilometers
    const durationMin = route.duration / 60;   // Convert seconds to minutes
    
    console.log(`✅ Backend OSRM route: ${distanceKm.toFixed(1)}km, ${durationMin.toFixed(0)} minutes, ${routeCoordinates.length} points`);
    
    return {
      coordinates: routeCoordinates,
      distance: distanceKm,
      duration: durationMin
    };
    
  } catch (error) {
    if (error.name === 'AbortError') {
      console.warn('Backend: OSRM API timeout, falling back to direct route');
    } else {
      console.error('Backend: Error calling OSRM API:', error);
    }
    console.log('Backend: Falling back to direct route calculation');
    return getDirectRoute(startPoint, endPoint);
  }
};

// Enhanced fallback direct route calculation
const getDirectRoute = (startPoint, endPoint) => {
  const directDistance = calculateDistance(startPoint.lat, startPoint.lng, endPoint.lat, endPoint.lng);
  const directDuration = (directDistance / 50) * 60; // Assume 50 km/h average
  
  // Generate smooth curve points for better animation
  const coordinates = [];
  const numPoints = Math.max(20, Math.min(100, Math.floor(directDistance * 3))); // More points for smoother animation
  
  for (let i = 0; i <= numPoints; i++) {
    const ratio = i / numPoints;
    
    // Add slight curve to make it look less robotic
    const curveFactor = 0.0001; // Small curve
    const curve = Math.sin(ratio * Math.PI) * curveFactor;
    
    coordinates.push({
      lat: startPoint.lat + (endPoint.lat - startPoint.lat) * ratio + curve,
      lng: startPoint.lng + (endPoint.lng - startPoint.lng) * ratio,
    });
  }
  
  console.log(`📍 Backend direct route fallback: ${directDistance.toFixed(1)}km, ${directDuration.toFixed(0)} minutes`);
  
  return {
    coordinates,
    distance: directDistance,
    duration: directDuration
  };
};

// ENHANCED: Calculate route from segments with support untuk partial routes
const calculateRouteFromSegments = async (segments) => {
  try {
    console.log('🛣️ Backend: Calculating route from', segments.length, 'segments with real road data');
    
    if (!segments || segments.length === 0) {
      throw new Error("No segments provided for route calculation");
    }

    if (segments.length === 1) {
      // Single segment - create a small loop for preview
      const segment = segments[0];
      const coordinates = [
        segment.location,
        {
          lat: segment.location.lat + 0.001,
          lng: segment.location.lng + 0.001
        },
        segment.location
      ];
      
      return {
        coordinates,
        distance: 0.1,
        duration: 1,
        segments: segments
      };
    }

    let totalDistance = 0;
    let totalDuration = 0;
    const allCoordinates = [];
    
    // Sort segments by order
    const sortedSegments = [...segments].sort((a, b) => a.order - b.order);
    
    // ENHANCED: Process each segment pair dengan better error handling
    for (let i = 0; i < sortedSegments.length - 1; i++) {
      const currentSegment = sortedSegments[i];
      const nextSegment = sortedSegments[i + 1];
      
      // Validate locations
      if (!currentSegment.location || !nextSegment.location) {
        console.warn('Backend: Skipping segment with missing location:', currentSegment.type, nextSegment.type);
        continue;
      }

      if (!isValidCoordinate(currentSegment.location.lat, currentSegment.location.lng) ||
          !isValidCoordinate(nextSegment.location.lat, nextSegment.location.lng)) {
        console.warn('Backend: Skipping segment with invalid coordinates:', currentSegment, nextSegment);
        continue;
      }
      
      let startPoint;
      let endPoint;
      let segmentType = 'direct';
      
      // Determine start point
      if (currentSegment.type === 'toll_entry' && currentSegment.toll_entry_gate) {
        startPoint = {
          name: currentSegment.toll_entry_gate.name,
          lat: currentSegment.toll_entry_gate.lat,
          lng: currentSegment.toll_entry_gate.lng
        };
      } else {
        startPoint = currentSegment.location;
      }
      
      // Determine end point and segment type
      if (nextSegment.type === 'toll_entry' && nextSegment.toll_entry_gate) {
        endPoint = {
          name: nextSegment.toll_entry_gate.name,
          lat: nextSegment.toll_entry_gate.lat,
          lng: nextSegment.toll_entry_gate.lng
        };
      } else if (nextSegment.type === 'toll_exit' && nextSegment.toll_exit_gate) {
        endPoint = {
          name: nextSegment.toll_exit_gate.name,
          lat: nextSegment.toll_exit_gate.lat,
          lng: nextSegment.toll_exit_gate.lng
        };
        segmentType = 'toll'; // This is a toll segment
      } else {
        endPoint = nextSegment.location;
      }
      
      // Skip if start and end points are too close (same location)
      const segmentDistance = calculateDistance(startPoint.lat, startPoint.lng, endPoint.lat, endPoint.lng);
      if (segmentDistance < 0.01) {
        console.log(`⚠️ Backend: Skipping segment ${i + 1} (distance too small: ${segmentDistance.toFixed(3)}km)`);
        continue;
      }
      
      // ENHANCED: Get real route with retry logic
      console.log(`🚗 Backend: Getting REAL route: ${startPoint.name} → ${endPoint.name} (${segmentType})`);
      
      let routeData;
      let attempts = 0;
      const maxAttempts = 2;
      
      while (attempts < maxAttempts) {
        try {
          routeData = await getRouteFromOSRM(startPoint, endPoint);
          break;
        } catch (error) {
          attempts++;
          console.warn(`Backend: Route attempt ${attempts} failed for ${startPoint.name} → ${endPoint.name}:`, error);
          if (attempts >= maxAttempts) {
            routeData = getDirectRoute(startPoint, endPoint);
          }
        }
      }
      
      if (!routeData || !routeData.coordinates || routeData.coordinates.length === 0) {
        console.warn(`Backend: No route data for segment ${i + 1}, using direct route`);
        routeData = getDirectRoute(startPoint, endPoint);
      }
      
      // Add calculated segment to totals
      totalDistance += routeData.distance;
      totalDuration += routeData.duration;
      
      // Add stop duration if this is a stop
      if (currentSegment.type === 'stop' && currentSegment.stop_duration) {
        totalDuration += currentSegment.stop_duration;
        console.log(`⏱️ Backend: Added ${currentSegment.stop_duration} minutes stop time at ${currentSegment.location.name}`);
      }
      
      // Add coordinates from this segment (avoid duplication)
      if (i === 0) {
        allCoordinates.push(...routeData.coordinates);
      } else {
        // Skip first point to avoid duplication, but ensure continuity
        const lastCoord = allCoordinates[allCoordinates.length - 1];
        const firstNewCoord = routeData.coordinates[0];
        
        // Check if there's a gap between segments
        if (lastCoord && firstNewCoord) {
          const gap = calculateDistance(lastCoord.lat, lastCoord.lng, firstNewCoord.lat, firstNewCoord.lng);
          if (gap > 0.1) { // If gap > 100m, add connecting line
            console.log(`🔗 Backend: Adding connection between segments (gap: ${gap.toFixed(2)}km)`);
            allCoordinates.push(firstNewCoord);
          }
        }
        
        allCoordinates.push(...routeData.coordinates.slice(1)); // Skip first point to avoid duplication
      }
      
      console.log(`📍 Backend Segment ${i + 1}: ${startPoint.name} → ${endPoint.name} (${routeData.distance.toFixed(1)}km, ${routeData.duration.toFixed(0)}min, ${segmentType}, ${routeData.coordinates.length} points)`);
    }
    
    // Ensure we have some coordinates
    if (allCoordinates.length === 0) {
      console.log('🔄 Backend: No coordinates found, creating fallback');
      
      // Use first and last segment locations for fallback
      const firstSegment = sortedSegments[0];
      const lastSegment = sortedSegments[sortedSegments.length - 1];
      
      if (firstSegment && lastSegment) {
        const fallbackRoute = await getRouteFromOSRM(firstSegment.location, lastSegment.location);
        allCoordinates.push(...fallbackRoute.coordinates);
        totalDistance = fallbackRoute.distance;
        totalDuration = fallbackRoute.duration;
      }
    }
    
    // Ensure minimum values
    totalDistance = Math.max(0.1, totalDistance);
    totalDuration = Math.max(1, totalDuration);
    
    console.log(`🏁 Backend Complete route: ${totalDistance.toFixed(1)}km, ${Math.round(totalDuration)} minutes, ${allCoordinates.length} coordinate points`);
    
    return {
      coordinates: allCoordinates,
      distance: totalDistance,
      duration: Math.round(totalDuration),
      segments: segments
    };
    
  } catch (error) {
    console.error('Backend: Error calculating route from segments:', error);
    
    // ENHANCED: Better emergency fallback
    if (segments.length >= 2) {
      const firstSegment = segments[0];
      const lastSegment = segments[segments.length - 1];
      
      if (firstSegment && lastSegment) {
        console.log('🚨 Backend: Using enhanced emergency fallback route');
        
        try {
          const emergencyRoute = await getRouteFromOSRM(firstSegment.location, lastSegment.location);
          return {
            coordinates: emergencyRoute.coordinates,
            distance: emergencyRoute.distance,
            duration: Math.round(emergencyRoute.duration),
            segments: segments
          };
        } catch (emergencyError) {
          console.error('Backend: Emergency fallback also failed:', emergencyError);
          
          // Ultimate fallback - direct line
          const directRoute = getDirectRoute(firstSegment.location, lastSegment.location);
          return {
            coordinates: directRoute.coordinates,
            distance: directRoute.distance,
            duration: Math.round(directRoute.duration),
            segments: segments
          };
        }
      }
    }
    
    throw new Error('Unable to calculate any route from the provided segments');
  }
};

module.exports = {
  calculateRouteFromSegments,
  getRouteFromOSRM,
  calculateDistance,
  isValidCoordinate
};