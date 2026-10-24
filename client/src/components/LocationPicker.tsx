import { useEffect, useId, useState } from 'react';
import { CircleMarker, MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { isValidGeoPoint, type GeoPoint } from '../lib/domain';
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
  onChange: (p: GeoPoint | null) => void;
  error?: string;
  required?: boolean;
}

export function LocationPicker({ value, onChange, error, required = false }: Props) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [latitude, setLatitude] = useState(value ? String(value.lat) : '');
  const [longitude, setLongitude] = useState(value ? String(value.lng) : '');
  const hasError = Boolean(error || geoError);

  useEffect(() => {
    setLatitude(value ? String(value.lat) : '');
    setLongitude(value ? String(value.lng) : '');
  }, [value]);

  function setLocation(point: GeoPoint) {
    if (!isValidGeoPoint(point)) {
      setGeoError('That location is not valid. Tap the map or try again.');
      onChange(null);
      return;
    }
    setGeoError(null);
    onChange(point);
  }

  function updateCoordinates(nextLatitude: string, nextLongitude: string) {
    setLatitude(nextLatitude);
    setLongitude(nextLongitude);
    const point = { lat: Number(nextLatitude), lng: Number(nextLongitude) };
    if (nextLatitude.trim() && nextLongitude.trim() && isValidGeoPoint(point)) {
      setLocation(point);
    } else {
      setGeoError('Enter a valid latitude and longitude.');
      onChange(null);
    }
  }

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
         setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        setLocating(false);
        setGeoError('We could not get your location. Tap the map to place the pin instead.');
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  return (
    <fieldset className="flex flex-col gap-3" aria-invalid={hasError}>
      <legend className="mb-1 text-[0.75rem] tracking-[0.02em] text-ink-muted">
        Location{required && <span aria-hidden="true"> (required)</span>}
      </legend>
      <p id={helpId} className="text-[0.75rem] text-ink-muted">
        Choose a point on the map, use your current location, or enter coordinates below.
      </p>
      <div className={cx('border', hasError ? 'border-error outline-2 -outline-offset-2 outline-error' : 'border-hairline')}>
        <MapContainer
          center={[DEFAULT_CENTER.lat, DEFAULT_CENTER.lng]}
          zoom={15}
          scrollWheelZoom={false}
          aria-label="Map for choosing the reported location"
          className="h-72 md:h-80 w-full"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
           <ClickToPlace onPick={setLocation} />
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
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-2 text-[0.75rem] tracking-[0.02em] text-ink-muted">
          Latitude
          <input
            type="number"
            inputMode="decimal"
            min="-90"
            max="90"
            step="any"
            value={latitude}
            required={required}
            onChange={(event) => updateCoordinates(event.target.value, longitude)}
            aria-describedby={hasError ? `${helpId} ${errorId}` : helpId}
            aria-invalid={hasError}
            className="min-h-12 w-full border-0 border-b border-field-rule bg-surface-1 px-4 text-base text-ink focus:outline-2 focus:-outline-offset-2 focus:outline-primary"
          />
        </label>
        <label className="flex flex-col gap-2 text-[0.75rem] tracking-[0.02em] text-ink-muted">
          Longitude
          <input
            type="number"
            inputMode="decimal"
            min="-180"
            max="180"
            step="any"
            value={longitude}
            required={required}
            onChange={(event) => updateCoordinates(latitude, event.target.value)}
            aria-describedby={hasError ? `${helpId} ${errorId}` : helpId}
            aria-invalid={hasError}
            className="min-h-12 w-full border-0 border-b border-field-rule bg-surface-1 px-4 text-base text-ink focus:outline-2 focus:-outline-offset-2 focus:outline-primary"
          />
        </label>
      </div>
      {(error || geoError) && <p id={errorId} className="text-[0.75rem] text-error" role="alert">{error ?? geoError}</p>}
    </fieldset>
  );
}
