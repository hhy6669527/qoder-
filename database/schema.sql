CREATE TABLE app.wavelength_rooms (
  id text PRIMARY KEY,
  version integer NOT NULL,
  expires_at bigint NOT NULL,
  state jsonb NOT NULL
);
CREATE INDEX wavelength_rooms_expiry ON app.wavelength_rooms (expires_at);
CREATE TABLE app.wavelength_limits (
  id text PRIMARY KEY,
  version integer NOT NULL,
  value integer NOT NULL,
  expires_at bigint NOT NULL
);
CREATE INDEX wavelength_limits_expiry ON app.wavelength_limits (expires_at);
