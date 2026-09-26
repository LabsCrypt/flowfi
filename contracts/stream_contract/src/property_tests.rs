use proptest::prelude::*;

#[derive(Clone, Debug)]
struct Model {
    deposited: i128,
    withdrawn: i128,
    rate: i128,
    last_time: u64,
    paused_at: Option<u64>,
}

impl Model {
    fn claimable(&self, now: u64) -> i128 {
        let end = self.paused_at.unwrap_or(now);
        let elapsed = end.saturating_sub(self.last_time) as i128;
        (elapsed.saturating_mul(self.rate))
            .min(self.deposited.saturating_sub(self.withdrawn).max(0))
    }
}

#[derive(Clone, Debug)]
enum Action {
    Advance(u32),
    Pause,
    Resume,
    Withdraw,
    TopUp(u32),
    Cancel,
}

fn action_strategy() -> impl Strategy<Value = Action> {
    prop_oneof![
        (1u32..10_000).prop_map(Action::Advance),
        Just(Action::Pause),
        Just(Action::Resume),
        Just(Action::Withdraw),
        (1u32..100_000).prop_map(Action::TopUp),
        Just(Action::Cancel),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 10_000, .. ProptestConfig::default() })]
    #[test]
    fn randomized_stream_invariants(
        deposited in 1i128..1_000_000_000_000_000_000i128,
        duration in 1u64..100_000u64,
        actions in prop::collection::vec(action_strategy(), 1..100),
    ) {
        let mut model = Model { deposited, withdrawn: 0, rate: (deposited / duration as i128).max(1), last_time: 0, paused_at: None };
        let mut now = 0u64;
        let mut previous_withdrawn = 0i128;
        let mut paused_claimable = None;
        let mut cancelled = false;

        for action in actions {
            match action {
                Action::Advance(dt) if !cancelled => now = now.saturating_add(dt as u64),
                Action::Pause if !cancelled && model.paused_at.is_none() => {
                    paused_claimable = Some(model.claimable(now));
                    model.paused_at = Some(now);
                },
                Action::Resume if !cancelled => {
                    if let Some(paused_at) = model.paused_at.take() {
                        let pause_duration = now.saturating_sub(paused_at);
                        model.last_time = model.last_time.saturating_add(pause_duration);
                    }
                },
                Action::Withdraw if !cancelled => {
                    let amount = model.claimable(now);
                    model.withdrawn = model.withdrawn.saturating_add(amount);
                    model.last_time = now;
                    paused_claimable = None;
                },
                Action::TopUp(amount) if !cancelled => {
                    let accrued = model.claimable(now);
                    model.deposited = model.deposited.saturating_add(amount as i128);
                    if model.paused_at.is_none() {
                        model.last_time = now;
                    }
                    let _ = accrued;
                },
                Action::Cancel if !cancelled => {
                    model.withdrawn = model.withdrawn.saturating_add(model.claimable(now));
                    cancelled = true;
                },
                _ => {}
            }

            prop_assert!(model.withdrawn >= previous_withdrawn);
            prop_assert!(model.withdrawn <= model.deposited);
            prop_assert!(model.deposited >= model.withdrawn.saturating_add(model.claimable(now)));
            if model.paused_at.is_some() && paused_claimable.is_some() && !cancelled {
                prop_assert!(model.claimable(now) - paused_claimable.unwrap() <= (model.deposited - deposited));
            }
            previous_withdrawn = model.withdrawn;
        }
    }
}
