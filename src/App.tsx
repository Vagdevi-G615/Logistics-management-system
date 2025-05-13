import React, { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap } from 'react-leaflet';
import { LatLngTuple, LatLng } from 'leaflet';
import { Search, Loader2, Navigation, Clock, Route, Truck } from 'lucide-react';
import 'leaflet/dist/leaflet.css';

// Fix for default marker icons in React-Leaflet
import L from 'leaflet';
import icon from 'leaflet/dist/images/marker-icon.png';
import iconShadow from 'leaflet/dist/images/marker-shadow.png';

const DefaultIcon = L.icon({
  iconUrl: icon,
  shadowUrl: iconShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});

L.Marker.prototype.options.icon = DefaultIcon;

interface Location {
  lat: number;
  lon: number;
  display_name: string;
}

// Component to fit map bounds when route changes
function MapBounds({ route }: { route: LatLngTuple[] }) {
  const map = useMap();

  useEffect(() => {
    if (route.length > 0) {
      const bounds = L.latLngBounds(route.map(coords => L.latLng(coords[0], coords[1])));
      map.fitBounds(bounds, { padding: [50, 50] });
    }
  }, [route, map]);

  return null;
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = Math.round(minutes % 60);
  
  if (hours === 0) {
    return `${remainingMinutes} mins`;
  } else if (remainingMinutes === 0) {
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  } else {
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ${remainingMinutes} mins`;
  }
}

function App() {
  const [fromLocation, setFromLocation] = useState('');
  const [toLocation, setToLocation] = useState('');
  const [route, setRoute] = useState<LatLngTuple[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routeInfo, setRouteInfo] = useState<{ 
    distance: number; 
    duration: number;
    restStops: number;
    alternatives?: LatLngTuple[][];
    trafficLevel?: 'low' | 'medium' | 'high';
  } | null>(null);
  const mapRef = useRef<L.Map | null>(null);

  const searchLocation = async (query: string): Promise<Location | null> => {
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
        {
          headers: {
            'User-Agent': 'RoutePlanner/1.0',
          },
        }
      );
      const data = await response.json();
      return data[0] ? {
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon),
        display_name: data[0].display_name,
      } : null;
    } catch (error) {
      console.error('Error searching location:', error);
      return null;
    }
  };

  const calculateTruckDuration = (distance: number, routeType: string): { duration: number; restStops: number } => {
    // Short distance calculation (urban delivery)
    if (distance <= 15) {
      // For very short distances, use simplified urban calculation
      // Average speed 25 km/h in city + traffic lights and basic loading/unloading
      const baseMinutes = (distance / 25) * 60; // Basic travel time
      const loadUnloadTime = 15; // Reduced loading/unloading time for small deliveries
      const trafficBuffer = baseMinutes * 0.2; // 20% buffer for traffic
      
      return {
        duration: Math.round(baseMinutes + loadUnloadTime + trafficBuffer),
        restStops: 0
      };
    }

    // Regular calculation for longer distances
    const truckSpeeds = {
      motorway: 80,
      trunk: 60,
      primary: 50,
      secondary: 40,
      residential: 30
    };

    // Time factors for different conditions
    const timeFactors = {
      peakHours: 1.4,  // Reduced from 1.6
      normal: 1.2,     // Reduced from 1.3
      nighttime: 1.1
    };

    // Additional factors for trucks
    const truckFactors = {
      loadingUnloading: distance > 50 ? 30 : 20, // Reduced for shorter trips
      cityAccess: distance > 30 ? 20 : 10,
      weightStations: 15
    };

    // Calculate base speed based on distance
    let baseSpeed = truckSpeeds.primary;
    if (distance > 100) {
      baseSpeed = truckSpeeds.motorway;
    } else if (distance > 50) {
      baseSpeed = truckSpeeds.trunk;
    }

    // Calculate required rest stops (4.5 hours driving, 45 min rest)
    const drivingHours = distance / baseSpeed;
    const restStops = Math.floor(drivingHours / 4.5);
    const restTime = restStops * 45;

    // Calculate total duration
    let duration = (distance / baseSpeed) * 60;
    duration *= timeFactors.normal;
    duration += restTime;
    duration += truckFactors.loadingUnloading;
    
    if (distance < 50) {
      duration += truckFactors.cityAccess;
    }
    
    if (distance > 100) {
      duration += truckFactors.weightStations;
    }

    return {
      duration: Math.round(duration),
      restStops
    };
  };

  const getRoute = async (from: Location, to: Location) => {
    try {
      const response = await fetch(
        `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&alternatives=true`
      );
      const data = await response.json();

      if (data.code !== 'Ok') {
        throw new Error('Unable to find route between these locations');
      }

      const primaryRoute = data.routes[0];
      const coordinates = primaryRoute.geometry.coordinates.map(
        (coord: [number, number]): LatLngTuple => [coord[1], coord[0]]
      );

      const alternatives = data.routes.slice(1).map((route: any) =>
        route.geometry.coordinates.map(
          (coord: [number, number]): LatLngTuple => [coord[1], coord[0]]
        )
      );

      const distance = primaryRoute.distance / 1000;
      const { duration, restStops } = calculateTruckDuration(distance, primaryRoute.legs[0].summary);

      return {
        coordinates,
        distance,
        duration,
        restStops,
        alternatives
      };
    } catch (error) {
      console.error('Error fetching route:', error);
      throw new Error('Failed to calculate route');
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setRoute([]);
    setRouteInfo(null);

    try {
      const fromLoc = await searchLocation(fromLocation);
      const toLoc = await searchLocation(toLocation);

      if (!fromLoc || !toLoc) {
        throw new Error('Could not find one or both locations. Please check the spelling and try again.');
      }

      const routeData = await getRoute(fromLoc, toLoc);
      setRoute(routeData.coordinates);
      setRouteInfo({
        distance: routeData.distance,
        duration: routeData.duration,
        restStops: routeData.restStops,
        alternatives: routeData.alternatives
      });

    } catch (error) {
      setError(error instanceof Error ? error.message : 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-center gap-2 mb-8">
          <Truck className="w-8 h-8 text-blue-600" />
          <h1 className="text-3xl font-bold text-center">Logistics Route Planner</h1>
        </div>
        
        <div className="max-w-2xl mx-auto mb-8">
          <form onSubmit={handleSearch} className="space-y-4">
            <div className="flex flex-col md:flex-row gap-4">
              <input
                type="text"
                placeholder="From location"
                value={fromLocation}
                onChange={(e) => setFromLocation(e.target.value)}
                className="flex-1 p-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <input
                type="text"
                placeholder="To location"
                value={toLocation}
                onChange={(e) => setToLocation(e.target.value)}
                className="flex-1 p-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <button
                type="submit"
                disabled={loading}
                className="bg-blue-600 text-white px-6 py-3 rounded-lg flex items-center justify-center hover:bg-blue-700 disabled:bg-blue-400"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    Calculating...
                  </>
                ) : (
                  <>
                    <Navigation className="w-5 h-5 mr-2" />
                    Find Route
                  </>
                )}
              </button>
            </div>
          </form>

          {error && (
            <div className="mt-4 p-4 bg-red-100 text-red-700 rounded-lg">
              {error}
            </div>
          )}

          {routeInfo && (
            <div className="mt-4 p-4 bg-white rounded-lg shadow-sm">
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div className="text-center flex flex-col items-center">
                  <Route className="w-5 h-5 text-gray-600 mb-1" />
                  <p className="text-sm text-gray-600">Distance</p>
                  <p className="text-xl font-semibold">{routeInfo.distance.toFixed(1)} km</p>
                </div>
                <div className="text-center flex flex-col items-center">
                  <Clock className="w-5 h-5 text-gray-600 mb-1" />
                  <p className="text-sm text-gray-600">Estimated Time</p>
                  <p className="text-xl font-semibold">{formatDuration(routeInfo.duration)}</p>
                </div>
              </div>
              {routeInfo.restStops > 0 && (
                <div className="text-sm text-gray-600 text-center border-t pt-3">
                  <p>Required rest stops: {routeInfo.restStops}</p>
                  <p className="text-xs mt-1">(45-minute breaks included in total time)</p>
                </div>
              )}
              {routeInfo.alternatives && routeInfo.alternatives.length > 0 && (
                <p className="text-sm text-gray-600 mt-2 text-center">
                  {routeInfo.alternatives.length} alternative route(s) available
                </p>
              )}
            </div>
          )}
        </div>

        <div className="h-[600px] rounded-lg overflow-hidden shadow-lg">
          <MapContainer
            center={[20.5937, 78.9629]}
            zoom={5}
            className="h-full w-full"
            ref={mapRef}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {route.length > 0 && (
              <>
                <Polyline positions={route} color="blue" weight={4} opacity={0.8} />
                {routeInfo?.alternatives?.map((altRoute, index) => (
                  <Polyline 
                    key={index}
                    positions={altRoute} 
                    color="gray" 
                    weight={3} 
                    opacity={0.4} 
                    dashArray="5,10"
                  />
                ))}
                <Marker position={route[0]}>
                  <Popup>Start: {fromLocation}</Popup>
                </Marker>
                <Marker position={route[route.length - 1]}>
                  <Popup>End: {toLocation}</Popup>
                </Marker>
                <MapBounds route={route} />
              </>
            )}
          </MapContainer>
        </div>
      </div>
    </div>
  );
}

export default App;