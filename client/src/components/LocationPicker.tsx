import { useEffect, useState } from 'react';
import { CircleMarker, MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import type { GeoPoint } from '../lib/domain';
import { Button } from './Button';
import { cx } from '../lib/cx';

// NITK Surathkal: default view for the simulated demo city.
const DEFAULT_CENTER: GeoPoint = { lat: 13.0108, lng: 74.7943 };

function ClickToPlace({ onPick }: { onPick: (p: GeoPoint) => void }) {
  useMapEvents({
    click(e) {
      onPick({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

function FlyTo({ point }: { point: GeoPoint | null }) {
  const map = useMap();
  useEffect(() => {
    if (point && !map.getBounds().contains([point.lat, point.lng])) {
      map.setView([point.lat, point.lng], 17);
    }
  }, [map, point]);
  return null;
}

// Circle marker avoids Leaflet's default icon images, which break under bundlers.
const markerStyle = { color: '#ffffff', weight: 3, fillColor: '#0f62fe', fillOpacity: 1 };

interface Props {
  value: GeoPoint | null;
  onChange: (p: GeoPoint) => void;
  error?: string;
}

export function LocationPicker({ value, onChange, error }: Props) {
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  function useMyLocation() {
    if (!('geolocation' in navigator)) {
      setGeoError('Your browser cannot share its location. Tap the map instead.');
      return;
    }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        onChange({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        setLocating(false);
        setGeoError('We could not get your location. Tap the map to place the pin instead.');
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-[0.75rem] tracking-[0.02em] text-ink-muted mb-2">Location</legend>
      <div className={cx('border', error ? 'border-error outline-2 -outline-offset-2 outline-error' : 'border-hairline')}>
        <MapContainer
          center={[DEFAULT_CENTER.lat, DEFAULT_CENTER.lng]}
          zoom={15}
          scrollWheelZoom={false}
          className="h-72 md:h-80 w-full"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <ClickToPlace onPick={onChange} />
          <FlyTo point={value} />
          {value && <CircleMarker center={[value.lat, value.lng]} radius={10} pathOptions={markerStyle} />}
        </MapContainer>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button variant="tertiary" size="sm" onClick={useMyLocation} disabled={locating}>
          {locating ? 'Finding you…' : 'Use my current location'}
        </Button>
        <p className="text-[0.75rem] text-ink-muted" aria-live="polite">
          {value ? (
            <>
              Pin placed at{' '}
              <span className="font-mono">
                {value.lat.toFixed(5)}, {value.lng.toFixed(5)}
              </span>
            </>
          ) : (
            'Tap the map where the problem is.'
          )}
        </p>
      </div>
      {(error || geoError) && <p className="text-[0.75rem] text-error">{error ?? geoError}</p>}
    </fieldset>
  );
}
