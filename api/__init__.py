"""FastAPI layer that exposes the trajectory_sim Phase 1 pipeline over HTTP.

This is a thin wrapper — all real work (route parsing, waypoint
resolution, pyproj/WGS-84 geodesy, GeoPackage/CSV output) is done by the
canonical `trajectory_sim` package. The web app calls this so it uses the
*real* Python engine instead of a re-implementation.
"""
