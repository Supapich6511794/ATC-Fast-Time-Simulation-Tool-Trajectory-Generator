"""Navigation data lookup from the BearCat GeoPackage.

Loads the `waypoints` layer once at construction and exposes
identifier-based lookups for downstream trajectory generation. All
coordinates are returned as (latitude_deg, longitude_deg) in WGS-84
(EPSG:4326).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import geopandas as gpd
import pandas as pd

logger = logging.getLogger(__name__)

_WAYPOINTS_LAYER = "waypoints"


class WaypointNotFoundError(LookupError):
    """Raised when a waypoint identifier is not present in the navdata."""

    def __init__(self, ident: str) -> None:
        self.ident = ident
        super().__init__(f"Waypoint {ident!r} not found in navdata")


class NavData:
    """Read-only accessor for the BearCat navigation GeoPackage.

    The waypoints layer is loaded once at construction; an in-memory
    ident → (lat, lon) index is built for O(1) lookups. Coordinates are
    WGS-84 degrees.
    """

    def __init__(self, gpkg_path: str | Path) -> None:
        """Load and index the waypoints layer from a GeoPackage.

        Args:
            gpkg_path: Filesystem path to the BearCat navdata GeoPackage
                (e.g. "bearcat_navdata.gpkg"). The file must contain a
                "waypoints" layer with column `ident` (str) and POINT
                geometry in EPSG:4326.
        """
        self._gpkg_path = Path(gpkg_path)
        self._wpt_gdf: gpd.GeoDataFrame = gpd.read_file(
            self._gpkg_path, layer=_WAYPOINTS_LAYER
        )
        self._index: dict[str, tuple[float, float]] = self._build_index(
            self._wpt_gdf
        )

    @staticmethod
    def _build_index(
        gdf: gpd.GeoDataFrame,
    ) -> dict[str, tuple[float, float]]:
        """Build an ident → (lat_deg, lon_deg) lookup from the waypoints gdf.

        On duplicate idents, the first occurrence wins and subsequent
        rows are logged at DEBUG level. Real navdata can contain
        ambiguous idents across regions; disambiguation by country/type
        is out of scope for Phase 1.
        """
        index: dict[str, tuple[float, float]] = {}
        for ident, geom in zip(gdf["ident"], gdf.geometry, strict=True):
            if ident in index:
                logger.debug(
                    "Duplicate waypoint ident %s — keeping first occurrence",
                    ident,
                )
                continue
            index[ident] = (float(geom.y), float(geom.x))
        return index

    def lookup_waypoint(self, ident: str) -> tuple[float, float]:
        """Return (latitude_deg, longitude_deg) for a waypoint ident.

        Args:
            ident: ICAO waypoint identifier, e.g. "KARBI".

        Returns:
            (latitude_deg, longitude_deg) in WGS-84.

        Raises:
            WaypointNotFoundError: if `ident` is not in the navdata.
        """
        try:
            return self._index[ident]
        except KeyError:
            raise WaypointNotFoundError(ident) from None

    def lookup_waypoints_bulk(
        self, idents: list[str]
    ) -> dict[str, tuple[float, float]]:
        """Look up multiple waypoints at once, preserving input order.

        Args:
            idents: List of ICAO waypoint identifiers.

        Returns:
            Dict mapping each input ident to (latitude_deg,
            longitude_deg) in WGS-84. Insertion order matches `idents`.

        Raises:
            WaypointNotFoundError: on the first missing ident.
        """
        return {ident: self.lookup_waypoint(ident) for ident in idents}


@dataclass(frozen=True)
class RouteWaypoint:
    """One ordered point on an already-resolved route.

    Attributes:
        ident: ICAO waypoint identifier, e.g. "MOTNA".
        lat: Latitude in decimal degrees, WGS-84.
        lon: Longitude in decimal degrees, WGS-84.
    """

    ident: str
    lat: float
    lon: float


# Columns the supervisor's airway-segment CSV must contain. Each row is one
# leg of a published airway: (waypoint_identifier -> waypoint_identifier_2),
# with both endpoints' coordinates and a `seqno` giving the leg order.
_CSV_REQUIRED_COLS = (
    "seqno",
    "waypoint_identifier",
    "waypoint_latitude",
    "waypoint_longitude",
    "waypoint_identifier_2",
    "waypoint_latitude_2",
    "waypoint_longitude_2",
)


def load_route_csv(
    csv_path: str | Path, *, reverse: bool = False
) -> list[RouteWaypoint]:
    """Load an already-resolved route from an airway-segment CSV.

    This is an alternative to ``NavData`` + ``parse_route`` for the case
    where the route is delivered pre-resolved as consecutive airway legs
    (e.g. ``VTPStoVTBS.csv``) instead of as an FPL route string plus a
    waypoint GeoPackage. Each CSV row is one leg
    ``waypoint_identifier -> waypoint_identifier_2``; rows are chained in
    ascending ``seqno`` order into a single ordered waypoint list.

    No coordinate is invented — every (lat, lon) is read straight from the
    CSV's ``waypoint_*`` / ``waypoint_*_2`` columns.

    Args:
        csv_path: Path to the airway-segment CSV.
        reverse: If True, return the route in reverse leg order. The CSV's
            natural ``seqno`` order runs Bangkok -> Phuket; pass
            ``reverse=True`` to fly the VTSP -> VTBS direction.

    Returns:
        Ordered list of :class:`RouteWaypoint`. For N legs this yields the
        first leg's start fix followed by every leg's end fix (N + 1
        points), with consecutive duplicate idents collapsed.

    Raises:
        FileNotFoundError: if ``csv_path`` does not exist.
        ValueError: if required columns are missing or the file is empty.
    """
    path = Path(csv_path)
    if not path.is_file():
        raise FileNotFoundError(f"Route CSV not found: {path}")

    df = pd.read_csv(path)
    missing = [c for c in _CSV_REQUIRED_COLS if c not in df.columns]
    if missing:
        raise ValueError(
            f"Route CSV {path} missing required columns: {missing}"
        )
    if df.empty:
        raise ValueError(f"Route CSV {path} contains no rows")

    # Order the legs. seqno is the airway sequence number; sorting on it
    # gives the canonical (Bangkok -> Phuket) leg order.
    df = df.sort_values("seqno").reset_index(drop=True)

    route: list[RouteWaypoint] = []

    def _append(ident: str, lat: float, lon: float) -> None:
        # Collapse the shared boundary fix between consecutive legs
        # (leg i's end == leg i+1's start).
        if route and route[-1].ident == ident:
            return
        route.append(RouteWaypoint(ident=ident, lat=float(lat), lon=float(lon)))

    prev_end_ident: str | None = None
    for row in df.itertuples(index=False):
        start_ident = str(row.waypoint_identifier)
        end_ident = str(row.waypoint_identifier_2)

        # Sanity check: legs should chain (this leg starts where the
        # previous one ended). Warn but keep going so a single data gap
        # doesn't abort the whole route.
        if prev_end_ident is not None and start_ident != prev_end_ident:
            logger.warning(
                "Route discontinuity: leg starts at %s but previous leg "
                "ended at %s — inserting a direct segment between them",
                start_ident,
                prev_end_ident,
            )

        _append(start_ident, row.waypoint_latitude, row.waypoint_longitude)
        _append(end_ident, row.waypoint_latitude_2, row.waypoint_longitude_2)
        prev_end_ident = end_ident

    if reverse:
        route.reverse()

    logger.info(
        "Loaded %d-waypoint route from %s (%s -> %s)",
        len(route),
        path.name,
        route[0].ident if route else "?",
        route[-1].ident if route else "?",
    )
    return route
