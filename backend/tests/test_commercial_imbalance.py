"""Commercial Imbalance and GB System Imbalance sign-convention tests.

These encode the exact worked examples in the redesign brief.
"""

from __future__ import annotations

import pytest
from gb_battery.market.balance import (
    COMMERCIAL_TOLERANCE_MWH,
    classify_commercial,
    classify_system,
    commercial_position,
    metered_net_export_from_soc,
)

# --------------------------------------------------------------- commercial

@pytest.mark.parametrize(
    ("contracted", "metered", "expected_mwh", "expected_dir"),
    [
        # Sold 20 MWh (export +20), delivered 18 -> 18 - 20 = -2 -> SHORT 2.
        (20.0, 18.0, -2.0, "SHORT"),
        # Sold 20, delivered 23 -> +3 -> LONG 3.
        (20.0, 23.0, 3.0, "LONG"),
        # Bought 20 MWh (import -20), consumed 18 (-18) -> -18 - (-20) = +2 -> LONG 2.
        (-20.0, -18.0, 2.0, "LONG"),
        # Bought 20, consumed 23 (-23) -> -23 - (-20) = -3 -> SHORT 3.
        (-20.0, -23.0, -3.0, "SHORT"),
    ],
)
def test_commercial_examples(contracted, metered, expected_mwh, expected_dir):
    pos = commercial_position(
        contracted_net_export_mwh=contracted,
        confirmed_metered_net_export_mwh=metered,
    )
    assert pos.status == "paper"
    assert pos.commercial_imbalance_mwh == pytest.approx(expected_mwh)
    assert pos.direction == expected_dir


def test_positive_is_long_negative_is_short():
    assert classify_commercial(5.0) == "LONG"
    assert classify_commercial(-5.0) == "SHORT"


def test_tolerance_maps_near_zero_to_balanced():
    tiny = COMMERCIAL_TOLERANCE_MWH / 2
    assert classify_commercial(tiny) == "BALANCED"
    assert classify_commercial(-tiny) == "BALANCED"
    pos = commercial_position(
        contracted_net_export_mwh=10.0,
        confirmed_metered_net_export_mwh=10.0 + tiny,
    )
    assert pos.direction == "BALANCED"


def test_missing_contract_returns_unavailable():
    pos = commercial_position(
        contracted_net_export_mwh=None,
        confirmed_metered_net_export_mwh=18.0,
    )
    assert pos.status == "unavailable"
    assert pos.commercial_imbalance_mwh is None
    assert pos.unavailable_reason


def test_missing_metered_returns_unavailable():
    pos = commercial_position(
        contracted_net_export_mwh=20.0,
        confirmed_metered_net_export_mwh=None,
    )
    assert pos.status == "unavailable"
    assert pos.unavailable_reason


def test_recommendation_alone_cannot_settle_commercial_imbalance():
    # A recommendation is provided but no contract and no metered delivery.
    pos = commercial_position(
        contracted_net_export_mwh=None,
        confirmed_metered_net_export_mwh=None,
        model_recommended_net_export_mwh=9.0,
        trader_instructed_net_export_mwh=8.5,
    )
    assert pos.status == "unavailable"
    assert pos.commercial_imbalance_mwh is None


def test_confirmed_metered_overrides_model_and_instruction():
    # Contracted 10 export; model/instruction/executed all say ~8-9, but the
    # confirmed metered delivery (7.8) is what determines the imbalance.
    pos = commercial_position(
        contracted_net_export_mwh=10.0,
        model_recommended_net_export_mwh=9.0,
        trader_instructed_net_export_mwh=8.5,
        executed_net_export_mwh=8.2,
        confirmed_metered_net_export_mwh=7.8,
    )
    assert pos.commercial_imbalance_mwh == pytest.approx(-2.2)
    assert pos.direction == "SHORT"


# --------------------------------------------------------------- cashflow

def test_indicative_cashflow_sign_positive_price():
    pos = commercial_position(
        contracted_net_export_mwh=10.0,
        confirmed_metered_net_export_mwh=7.8,
        system_price_gbp_per_mwh=164.2,
    )
    # imbalance -2.2 MWh at +164.2 -> negative cashflow.
    assert pos.indicative_imbalance_cashflow_gbp == pytest.approx(-2.2 * 164.2)


def test_indicative_cashflow_sign_negative_price():
    pos = commercial_position(
        contracted_net_export_mwh=10.0,
        confirmed_metered_net_export_mwh=13.0,  # LONG +3
        system_price_gbp_per_mwh=-50.0,
    )
    # LONG +3 MWh at a negative price -> negative cashflow (paid to take export).
    assert pos.commercial_imbalance_mwh == pytest.approx(3.0)
    assert pos.indicative_imbalance_cashflow_gbp == pytest.approx(3.0 * -50.0)


# --------------------------------------------------------- MW <-> MWh & SoC

def test_mw_to_mwh_via_soc_discharge():
    # 30 MWh SoC down to 10 MWh over the period, 95% discharge efficiency.
    net = metered_net_export_from_soc(30.0, 10.0, 0.95, 0.95)
    assert net == pytest.approx(20.0 * 0.95)  # positive export


def test_mw_to_mwh_via_soc_charge():
    # SoC rose 20 MWh, 95% charge efficiency -> negative net export (import).
    net = metered_net_export_from_soc(10.0, 30.0, 0.95, 0.95)
    assert net == pytest.approx(-20.0 / 0.95)


# ------------------------------------------------------------------ system

def test_niv_positive_is_gb_system_short():
    assert classify_system(780.0) == "GB SYSTEM SHORT"


def test_niv_negative_is_gb_system_long():
    assert classify_system(-780.0) == "GB SYSTEM LONG"


def test_niv_zero_within_tolerance_is_balanced():
    assert classify_system(0.0) == "BALANCED"
    assert classify_system(0.5) == "BALANCED"


@pytest.mark.parametrize(
    ("commercial_mwh", "niv_mwh", "exp_comm", "exp_sys"),
    [
        (3.0, -780.0, "LONG", "GB SYSTEM LONG"),
        (3.0, 780.0, "LONG", "GB SYSTEM SHORT"),
        (-3.0, -780.0, "SHORT", "GB SYSTEM LONG"),
        (-3.0, 780.0, "SHORT", "GB SYSTEM SHORT"),
    ],
)
def test_all_four_commercial_system_combinations(commercial_mwh, niv_mwh, exp_comm, exp_sys):
    assert classify_commercial(commercial_mwh) == exp_comm
    assert classify_system(niv_mwh) == exp_sys
