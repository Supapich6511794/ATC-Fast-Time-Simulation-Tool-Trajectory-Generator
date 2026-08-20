"""Open-STAR classification and the vector-to-final path builder.

The geometry cases use the real VTBS RW19 arrival: the EAST/LEBI/TUMG STARs
end at ESGEN on a published heading of 015°, and the R19 approach's FAF is
BS790, 4.9 NM out on the extended centreline. That is the only place in the
Thai data where an arrival is handed to radar vectors.
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from trajectory_sim.geodesy import compute_bearing, haversine_distance
from trajectory_sim.navdata import (
    AltitudeConstraint,
    AltitudeConstraintType,
    AmbiguousProcedureError,
    NavData,
    Procedure,
    ProcedureLeg,
    ProcedureType,
    RouteWaypoint,
    RunwayEnd,
    SpeedConstraint,
    SpeedConstraintType,
)

from trajectory_sim.vectors import (
    MAX_INTERCEPT_DEG,
    faf_of,
    plan_open_star_join,
    vector_to_final,
)

_DATA = Path(__file__).resolve().parents[2] / "web" / "public" / "data"
_STAR_SRC = _DATA / "star" / "star_waypoint.geojson"
_PBN_SRC = _DATA / "pbn" / "pbn_waypoint.geojson"


@pytest.fixture(scope="module")
def nav_star() -> NavData:
    if not _STAR_SRC.is_file():
        pytest.skip("STAR source not present")
    return NavData(star_source=_STAR_SRC)


@pytest.fixture(scope="module")
def nav_both() -> NavData:
    if not (_STAR_SRC.is_file() and _PBN_SRC.is_file()):
        pytest.skip("STAR/PBN sources not present")
    return NavData(star_source=_STAR_SRC, approach_source=_PBN_SRC)

# --- real VTBS data -------------------------------------------------------
VTBS_RW19 = RunwayEnd(
    icao="VTBS",
    ident="RW19",
    lat=13.69171389,
    lon=100.76103333,
    magnetic_bearing=195.0,
    true_bearing=194.326,
)
ESGEN = RouteWaypoint(ident="ESGEN", lat=13.99625556, lon=100.93103889)
BS790_FAF_NM = 4.9  # R19's FAF, on the extended centreline
VECTOR_HEADING_TRUE = 015.0 + (VTBS_RW19.true_bearing - VTBS_RW19.magnetic_bearing)


def _no_alt() -> AltitudeConstraint:
    return AltitudeConstraint(type=AltitudeConstraintType.NONE)


def _no_spd() -> SpeedConstraint:
    return SpeedConstraint(type=SpeedConstraintType.NONE)


def _leg(seq: int, term: str, ident: str | None, lat=None, lon=None, desc=None):
    return ProcedureLeg(
        seqno=seq,
        path_terminator=term,
        ident=ident,
        lat=lat,
        lon=lon,
        altitude=_no_alt(),
        speed=_no_spd(),
        desc_code=desc,
    )


def _star(*legs: ProcedureLeg) -> Procedure:
    return Procedure(
        airport="VTBS",
        name="EAST1C",
        proc_type=ProcedureType.STAR,
        runway="RW19",
        transition=None,
        legs=tuple(legs),
    )


# --- B: open vs closed ----------------------------------------------------
class TestOpenStarClassification:
    def test_vm_terminated_star_is_open(self) -> None:
        """VTBS EAST1C RW19: ... -> ESGEN -> VM. The VM leg is coded with the
        AERODROME as its waypoint, which is why it must not be taken as a fix."""
        star = _star(
            _leg(10, "TF", "ATKIN", 14.04447222, 100.74071944),
            _leg(20, "TF", "ESGEN", 13.99625556, 100.93103889),
            _leg(30, "VM", "VTBS", 13.68194444, 100.74722222),
        )
        assert star.is_open is True
        assert star.vector_termination is not None
        assert star.vector_termination.path_terminator == "VM"
        # The vector leg contributes no waypoint, so the last FLYABLE fix is
        # where the assigned heading begins.
        assert star.last_fix().ident == "ESGEN"
        assert [w.ident for w in star.waypoints()] == ["ATKIN", "ESGEN"]

    def test_fix_terminated_star_is_closed(self) -> None:
        star = _star(
            _leg(10, "TF", "PANTA", 14.20, 100.60),
            _leg(20, "TF", "NORTA", 14.05, 100.70),
        )
        assert star.is_open is False
        assert star.vector_termination is None
        assert star.last_fix().ident == "NORTA"

    @pytest.mark.parametrize("term", ["VM", "FM", "VI", "VR"])
    def test_every_vector_terminator_counts_as_open(self, term: str) -> None:
        star = _star(_leg(10, "TF", "ATKIN", 14.04, 100.74), _leg(20, term, None))
        assert star.is_open is True

    def test_empty_procedure_is_not_open(self) -> None:
        assert _star().is_open is False
        assert _star().last_fix() is None

    def test_only_the_LAST_leg_opens_a_procedure(self) -> None:
        """A vector leg in the middle (rare, but codeable) does not make the
        arrival open — it still ends at a fix the aircraft can fly to."""
        star = _star(
            _leg(10, "VI", None),
            _leg(20, "TF", "ESGEN", 13.99625556, 100.93103889),
        )
        assert star.is_open is False


class TestFafLookup:
    def test_finds_the_fix_flagged_F_in_the_description_code(self) -> None:
        approach = Procedure(
            airport="VTBS",
            name="R19",
            proc_type=ProcedureType.APPROACH,
            runway="RW19",
            transition=None,
            legs=(
                _leg(10, "IF", "LAVOG", 13.93505278, 100.82506389, desc="E  I"),
                _leg(15, "TF", "LOTMU", 13.85399722, 100.80371667, desc="E S"),
                _leg(20, "TF", "BS790", 13.77066944, 100.78179167, desc="E  F"),
                _leg(30, "TF", "BS791", 13.69171389, 100.76103333, desc="EY M"),
            ),
        )
        faf = faf_of(approach)
        assert faf is not None and faf.ident == "BS790"

    def test_returns_none_when_no_leg_is_flagged(self) -> None:
        approach = Procedure(
            airport="VTBS",
            name="R19",
            proc_type=ProcedureType.APPROACH,
            runway="RW19",
            transition=None,
            legs=(_leg(10, "IF", "LAVOG", 13.9, 100.8, desc="E  I"),),
        )
        assert faf_of(approach) is None


# --- C: the vector path ---------------------------------------------------
def _centreline_offset_nm(point: RouteWaypoint) -> float:
    """Perpendicular distance from the RW19 extended centreline (NM)."""
    d = haversine_distance(
        VTBS_RW19.lat, VTBS_RW19.lon, point.lat, point.lon
    )
    brg = compute_bearing(VTBS_RW19.lat, VTBS_RW19.lon, point.lat, point.lon)
    outbound = (VTBS_RW19.true_bearing + 180.0) % 360.0
    return abs(d * math.sin(math.radians(brg - outbound)))


class TestVectorToFinal:
    def test_builds_a_join_for_the_real_VTBS_RW19_downwind(self) -> None:
        v = vector_to_final(
            start=ESGEN,
            heading_deg=VECTOR_HEADING_TRUE,
            runway=VTBS_RW19,
            faf_nm=BS790_FAF_NM,
        )
        assert v is not None
        assert v.downwind_nm >= 1.0
        assert v.base_nm >= 1.0
        assert v.track_nm == pytest.approx(v.downwind_nm + v.base_nm)

    def test_the_intercept_lands_ON_the_extended_centreline(self) -> None:
        v = vector_to_final(
            start=ESGEN,
            heading_deg=VECTOR_HEADING_TRUE,
            runway=VTBS_RW19,
            faf_nm=BS790_FAF_NM,
        )
        assert _centreline_offset_nm(v.intercept_point) == pytest.approx(0, abs=0.05)

    def test_turn_point_lies_on_the_assigned_heading_from_the_STAR_fix(self) -> None:
        """The downwind IS the published clearance — the turn must happen on
        that heading, not on a convenient bearing of the solver's choosing."""
        v = vector_to_final(
            start=ESGEN,
            heading_deg=VECTOR_HEADING_TRUE,
            runway=VTBS_RW19,
            faf_nm=BS790_FAF_NM,
        )
        flown = compute_bearing(
            ESGEN.lat, ESGEN.lon, v.turn_point.lat, v.turn_point.lon
        )
        assert flown == pytest.approx(VECTOR_HEADING_TRUE, abs=0.5)
        assert haversine_distance(
            ESGEN.lat, ESGEN.lon, v.turn_point.lat, v.turn_point.lon
        ) == pytest.approx(v.downwind_nm, abs=0.05)

    def test_base_leg_meets_final_at_the_requested_intercept_angle(self) -> None:
        v = vector_to_final(
            start=ESGEN,
            heading_deg=VECTOR_HEADING_TRUE,
            runway=VTBS_RW19,
            faf_nm=BS790_FAF_NM,
            intercept_deg=30.0,
        )
        base_track = compute_bearing(
            v.turn_point.lat, v.turn_point.lon,
            v.intercept_point.lat, v.intercept_point.lon,
        )
        delta = abs((base_track - VTBS_RW19.true_bearing + 180) % 360 - 180)
        assert delta == pytest.approx(30.0, abs=0.5)
        assert v.intercept_angle_deg == pytest.approx(30.0)

    def test_intercept_angle_is_capped_at_the_Doc4444_45_degrees(self) -> None:
        v = vector_to_final(
            start=ESGEN,
            heading_deg=VECTOR_HEADING_TRUE,
            runway=VTBS_RW19,
            faf_nm=BS790_FAF_NM,
            intercept_deg=80.0,  # illegal ask
        )
        assert v.intercept_angle_deg == pytest.approx(MAX_INTERCEPT_DEG)

    def test_joins_outside_the_FAF_so_the_glide_path_is_met_established(self) -> None:
        """§8.9.3.6 — established on the final approach track BEFORE the glide
        path, which is intercepted at the FAF."""
        v = vector_to_final(
            start=ESGEN,
            heading_deg=VECTOR_HEADING_TRUE,
            runway=VTBS_RW19,
            faf_nm=BS790_FAF_NM,
            established_nm=2.0,
        )
        assert v.established_nm >= 2.0
        # The intercept is further from the threshold than the FAF is.
        d_icpt = haversine_distance(
            VTBS_RW19.lat, VTBS_RW19.lon,
            v.intercept_point.lat, v.intercept_point.lon,
        )
        assert d_icpt > BS790_FAF_NM

    def test_a_longer_established_leg_pushes_the_intercept_further_out(self) -> None:
        near = vector_to_final(
            start=ESGEN, heading_deg=VECTOR_HEADING_TRUE, runway=VTBS_RW19,
            faf_nm=BS790_FAF_NM, established_nm=2.0,
        )
        far = vector_to_final(
            start=ESGEN, heading_deg=VECTOR_HEADING_TRUE, runway=VTBS_RW19,
            faf_nm=BS790_FAF_NM, established_nm=8.0,
        )
        assert far.established_nm > near.established_nm


class TestDownwindExtension:
    """`extend_nm` is the spacing deficit from the arrival sequencer — the
    "maintain heading until separation" instruction, in track miles."""

    def test_extending_the_downwind_lengthens_the_total_track(self) -> None:
        base = vector_to_final(
            start=ESGEN, heading_deg=VECTOR_HEADING_TRUE, runway=VTBS_RW19,
            faf_nm=BS790_FAF_NM,
        )
        longer = vector_to_final(
            start=ESGEN, heading_deg=VECTOR_HEADING_TRUE, runway=VTBS_RW19,
            faf_nm=BS790_FAF_NM, extend_nm=6.0,
        )
        assert longer.track_nm > base.track_nm
        assert longer.downwind_nm > base.downwind_nm

    def test_the_stretch_delivers_the_DISTANCE_TO_TOUCHDOWN_asked_for(self) -> None:
        """`extend_nm` is a spacing deficit, so it has to be measured in the
        distance that sets the landing time — all the way to the threshold, not
        just the vector legs. Extending the downwind also moves the intercept
        out, so the final grows too; counting only the vector legs would
        deliver half the spacing that was asked for."""
        base = vector_to_final(
            start=ESGEN, heading_deg=VECTOR_HEADING_TRUE, runway=VTBS_RW19,
            faf_nm=BS790_FAF_NM,
        )
        for want in (2.0, 5.0, 10.0):
            v = vector_to_final(
                start=ESGEN, heading_deg=VECTOR_HEADING_TRUE, runway=VTBS_RW19,
                faf_nm=BS790_FAF_NM, extend_nm=want,
            )
            assert v.total_nm - base.total_nm == pytest.approx(want, abs=0.1)
            # And it stays legal while doing it.
            assert v.intercept_angle_deg <= MAX_INTERCEPT_DEG
            assert _centreline_offset_nm(v.intercept_point) == pytest.approx(
                0, abs=0.05
            )

    def test_the_downwind_grows_by_about_HALF_the_requested_distance(self) -> None:
        """The 2:1 rule: on this geometry the downwind runs parallel to the
        centreline, so 1 NM more downwind also puts the intercept 1 NM further
        out — 2 NM of extra distance to touchdown for 1 NM of heading."""
        base = vector_to_final(
            start=ESGEN, heading_deg=VECTOR_HEADING_TRUE, runway=VTBS_RW19,
            faf_nm=BS790_FAF_NM,
        )
        v = vector_to_final(
            start=ESGEN, heading_deg=VECTOR_HEADING_TRUE, runway=VTBS_RW19,
            faf_nm=BS790_FAF_NM, extend_nm=10.0,
        )
        assert v.downwind_nm - base.downwind_nm == pytest.approx(5.0, abs=0.2)

    def test_shortest_total_reports_what_a_stretch_actually_achieved(self) -> None:
        v = vector_to_final(
            start=ESGEN, heading_deg=VECTOR_HEADING_TRUE, runway=VTBS_RW19,
            faf_nm=BS790_FAF_NM, extend_nm=7.0,
        )
        assert v.total_nm - v.shortest_total_nm == pytest.approx(7.0, abs=0.1)

    def test_an_impossible_stretch_is_reported_short_not_invented(self) -> None:
        """Past the downwind limit the extension cannot be delivered. The path
        must come back SHORT of the request so the caller can hold instead —
        silently returning a path that looks like it worked would hide the
        one case where a hold is the right answer."""
        v = vector_to_final(
            start=ESGEN, heading_deg=VECTOR_HEADING_TRUE, runway=VTBS_RW19,
            faf_nm=BS790_FAF_NM, extend_nm=500.0, max_downwind_nm=10.0,
        )
        assert v is not None
        assert v.total_nm - v.shortest_total_nm < 500.0
        # It stopped because the downwind hit its limit, not for some other
        # reason — and it did not overrun that limit to fake the request.
        assert v.downwind_nm == pytest.approx(10.0, abs=0.05)


class TestAgainstPublishedThaiData:
    """End-to-end on the real DFD export, not hand-built legs: load VTBS's
    STARs and R19 approach through NavData, find the open ones, and vector
    them onto final."""

    @staticmethod
    def _resolve(nav: NavData, name: str, **kw) -> Procedure | None:
        """A STAR with several enroute transitions needs one naming; pick the
        first, since the vector termination is on the shared runway leg."""
        try:
            return nav.lookup_procedure("VTBS", name, **kw)
        except AmbiguousProcedureError as exc:
            if exc.kind != "transition":
                return None
            return nav.lookup_procedure(
                "VTBS", name, transition=sorted(exc.candidates)[0], **kw
            )
        except LookupError:
            return None

    # The AIP STAR charts carry the hand-over as a note, and it names the fixes
    # explicitly. RNAV RWY19/20L/20R (the …1C arrivals):
    #
    #   "After ESGEN, ATKIN maintain heading 015° or as directed by ATC.
    #    Do not proceed Instrument Approach Procedure without ATC clearance."
    #
    # RNAV RWY01/02L/02R (the …1D arrivals) says the same for ENKAA, BOGAS on
    # heading 195°. Vectoring therefore begins at ONE of those fixes — not at
    # any waypoint an aircraft happens to be over. This table is that note.
    CHART_HANDOVER = {
        "RW19": ({"ESGEN", "ATKIN"}, 15.0),
        "RW01": ({"ENKAA", "BOGAS"}, 195.0),
    }

    @pytest.mark.parametrize("runway", ["RW19", "RW01"])
    def test_the_handover_matches_the_fixes_printed_on_the_STAR_chart(
        self, nav_star: NavData, runway: str
    ) -> None:
        """Every open VTBS arrival must hand over to vectors at a fix the chart
        names, on the heading the chart prints."""
        expect_fixes, expect_course = self.CHART_HANDOVER[runway]
        seen: set[str] = set()
        for name in nav_star.list_procedures("VTBS", ProcedureType.STAR):
            proc = self._resolve(
                nav_star, name, proc_type=ProcedureType.STAR, runway=runway
            )
            if proc is None or not proc.is_open:
                continue
            start = proc.last_fix()
            leg = proc.vector_termination
            assert start is not None and leg is not None
            # Where the aircraft stops following the STAR.
            assert start.ident in expect_fixes, (
                f"{name} {runway} hands over at {start.ident}, but the chart "
                f"names {sorted(expect_fixes)}"
            )
            # And the heading it then holds.
            assert leg.magnetic_course == pytest.approx(expect_course), name
            seen.add(start.ident)
        assert seen == expect_fixes, (
            f"{runway}: chart names {sorted(expect_fixes)} but the coded "
            f"procedures only hand over at {sorted(seen)}"
        )

    def test_the_published_VTBS_arrivals_are_the_open_ones(
        self, nav_star: NavData
    ) -> None:
        nav = nav_star
        open_names = []
        for name in nav.list_procedures("VTBS", ProcedureType.STAR):
            proc = self._resolve(
                nav, name, proc_type=ProcedureType.STAR, runway="RW19"
            )
            if proc is not None and proc.is_open:
                open_names.append(name)
        # EAST/LEBI/NORT/TUMG/WILA …1C serve RW19 and all end in vectors.
        assert open_names, "expected VTBS RW19 arrivals to end in radar vectors"
        assert all(n.endswith("1C") for n in open_names)

    def test_a_published_open_STAR_vectors_onto_the_published_R19_final(
        self, nav_both: NavData
    ) -> None:
        nav = nav_both
        star = self._resolve(
            nav, "EAST1C", proc_type=ProcedureType.STAR, runway="RW19"
        )
        assert star is not None and star.is_open
        approach = self._resolve(
            nav, "R19", proc_type=ProcedureType.APPROACH, runway="RW19"
        )
        assert approach is not None
        faf = faf_of(approach)
        assert faf is not None
        faf_nm = haversine_distance(
            VTBS_RW19.lat, VTBS_RW19.lon, faf.lat, faf.lon
        )

        start = star.last_fix()
        leg = star.vector_termination
        assert leg is not None and leg.magnetic_course is not None
        heading_true = (
            leg.magnetic_course + VTBS_RW19.magnetic_variation
        ) % 360.0

        v = vector_to_final(
            start=start,
            heading_deg=heading_true,
            runway=VTBS_RW19,
            faf_nm=faf_nm,
        )
        assert v is not None
        assert v.intercept_angle_deg <= MAX_INTERCEPT_DEG
        assert _centreline_offset_nm(v.intercept_point) == pytest.approx(0, abs=0.05)
        # The join is outside the FAF, so the glide path is met established.
        assert v.established_nm >= 2.0
        # And the whole pattern is a sane size for a TMA, not a excursion.
        assert 5.0 < v.total_nm < 60.0


class TestOpenStarJoin:
    """The whole spliced arrival: STAR fixes, vector legs, then the approach
    from its FAF in — the initial/intermediate approach is NOT flown, because
    vectoring terminates when the aircraft turns onto final (§8.9.4.1)."""

    def test_splices_star_then_vectors_then_the_approach_inside_the_join(
        self, nav_both: NavData
    ) -> None:
        nav = nav_both
        star = TestAgainstPublishedThaiData._resolve(
            nav, "EAST1C", proc_type=ProcedureType.STAR, runway="RW19"
        )
        approach = TestAgainstPublishedThaiData._resolve(
            nav, "R19", proc_type=ProcedureType.APPROACH, runway="RW19"
        )
        result = plan_open_star_join(star, approach, VTBS_RW19)
        assert result is not None
        fixes, vtf = result
        idents = [w.ident for w in fixes]

        # The STAR's own fixes lead, ending at the vector termination.
        assert idents[: len(star.waypoints())] == [
            w.ident for w in star.waypoints()
        ]
        # Then the two vector legs.
        assert idents[len(star.waypoints()) : len(star.waypoints()) + 2] == [
            "TURN",
            "INTC",
        ]
        # Then the approach, cut at the intercept: fixes INSIDE the join are
        # kept (the aircraft overflies them, and their crossing minima still
        # apply); the ones outside belong to the IAF entry it never flew.
        faf = faf_of(approach)
        assert faf.ident in idents
        join_nm = haversine_distance(
            VTBS_RW19.lat, VTBS_RW19.lon,
            vtf.intercept_point.lat, vtf.intercept_point.lon,
        )
        kept, cut = [], []
        for w in approach.waypoints():
            d = haversine_distance(VTBS_RW19.lat, VTBS_RW19.lon, w.lat, w.lon)
            (kept if d < join_nm else cut).append(w.ident)
        assert cut, "expected some approach fixes to sit outside the join"
        for ident in kept:
            assert ident in idents
        for ident in cut:
            assert ident not in idents

        # The path only ever moves closer to the threshold once on final.
        d_intc = haversine_distance(
            VTBS_RW19.lat, VTBS_RW19.lon, vtf.intercept_point.lat,
            vtf.intercept_point.lon,
        )
        assert d_intc > haversine_distance(
            VTBS_RW19.lat, VTBS_RW19.lon, faf.lat, faf.lon
        )

    def test_extending_the_join_delays_the_arrival(self, nav_both: NavData) -> None:
        nav = nav_both
        star = TestAgainstPublishedThaiData._resolve(
            nav, "EAST1C", proc_type=ProcedureType.STAR, runway="RW19"
        )
        approach = TestAgainstPublishedThaiData._resolve(
            nav, "R19", proc_type=ProcedureType.APPROACH, runway="RW19"
        )
        _f0, v0 = plan_open_star_join(star, approach, VTBS_RW19)
        _f1, v1 = plan_open_star_join(star, approach, VTBS_RW19, extend_nm=8.0)
        assert v1.total_nm - v0.total_nm == pytest.approx(8.0, abs=0.15)

    def test_returns_none_for_a_closed_star(self) -> None:
        closed = _star(
            _leg(10, "TF", "PANTA", 14.20, 100.60),
            _leg(20, "TF", "NORTA", 14.05, 100.70),
        )
        approach = Procedure(
            airport="VTBS", name="R19", proc_type=ProcedureType.APPROACH,
            runway="RW19", transition=None,
            legs=(_leg(20, "TF", "BS790", 13.77066944, 100.78179167, desc="E  F"),),
        )
        assert plan_open_star_join(closed, approach, VTBS_RW19) is None

    def test_returns_none_when_the_approach_has_no_FAF(self) -> None:
        open_star = _star(
            _leg(20, "TF", "ESGEN", 13.99625556, 100.93103889),
            ProcedureLeg(
                seqno=30, path_terminator="VM", ident="VTBS", lat=13.68, lon=100.74,
                altitude=_no_alt(), speed=_no_spd(), magnetic_course=15.0,
            ),
        )
        approach = Procedure(
            airport="VTBS", name="R19", proc_type=ProcedureType.APPROACH,
            runway="RW19", transition=None,
            legs=(_leg(10, "IF", "LAVOG", 13.93, 100.82, desc="E  I"),),
        )
        assert plan_open_star_join(open_star, approach, VTBS_RW19) is None


class TestInfeasibleGeometry:
    def test_a_heading_parallel_to_final_never_closes(self) -> None:
        """Flying the final approach track itself, offset to one side, the two
        lines never meet — there is no vector solution, and the caller must
        re-sequence rather than be handed a fabricated join."""
        offset = RouteWaypoint(ident="OFF", lat=ESGEN.lat, lon=ESGEN.lon)
        v = vector_to_final(
            start=offset,
            heading_deg=VTBS_RW19.true_bearing,  # straight down the FAT
            runway=VTBS_RW19,
            faf_nm=BS790_FAF_NM,
            intercept_deg=0.0,  # and no intercept angle to close with
        )
        assert v is None

    def test_returns_none_rather_than_a_backwards_join(self) -> None:
        """Started well inside the FAF and flying away, nothing legal remains
        within a short downwind limit."""
        inside = RouteWaypoint(ident="IN", lat=13.72, lon=100.77)
        v = vector_to_final(
            start=inside,
            heading_deg=(VTBS_RW19.true_bearing + 180.0) % 360.0,
            runway=VTBS_RW19,
            faf_nm=BS790_FAF_NM,
            max_downwind_nm=0.5,
        )
        assert v is None
