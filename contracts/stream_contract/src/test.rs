#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    xdr, Address, Env, IntoVal, Symbol, TryFromVal,
};

#[test]
fn withdraw_succeeds_for_authorized_recipient() {
    let env = Env::default();
    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    let recipient = Address::generate(&env);
    let stream_id = 1_u64;

    client
        .mock_auths(&[MockAuth {
            address: &recipient,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "withdraw",
                args: (recipient.clone(), stream_id).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .withdraw(&recipient, &stream_id);

    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, recipient);
}

#[test]
fn withdraw_fails_for_non_recipient_and_authorized_call_still_succeeds() {
    let env = Env::default();
    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    let recipient = Address::generate(&env);
    let attacker = Address::generate(&env);
    let stream_id = 1_u64;

    let unauthorized_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client
            .mock_auths(&[MockAuth {
                address: &attacker,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "withdraw",
                    args: (recipient.clone(), stream_id).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .withdraw(&recipient, &stream_id);
    }));
    assert!(unauthorized_result.is_err());

    client
        .mock_auths(&[MockAuth {
            address: &recipient,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "withdraw",
                args: (recipient.clone(), stream_id).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .withdraw(&recipient, &stream_id);

    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, recipient);
}

#[test]
fn stream_contracttype_layout_snapshot() {
    let env = Env::default();
    let recipient = Address::generate(&env);
    let stream = Stream(7_u64, recipient.clone(), -5_i128);

    let stream_scval: xdr::ScVal = (&stream).try_into().unwrap();
    let expected_snapshot: xdr::ScVal = (&(7_u64, recipient.clone(), -5_i128)).try_into().unwrap();
    assert_eq!(stream_scval, expected_snapshot);

    let values = match &stream_scval {
        xdr::ScVal::Vec(Some(values)) => values,
        _ => panic!("stream must serialize as ScVal::Vec"),
    };
    assert_eq!(values.len(), 3);

    match &values[0] {
        xdr::ScVal::U64(v) => assert_eq!(*v, 7_u64),
        _ => panic!("stream[0] must be u64"),
    }

    let expected_address: xdr::ScAddress = recipient.try_into().unwrap();
    match &values[1] {
        xdr::ScVal::Address(addr) => assert_eq!(addr, &expected_address),
        _ => panic!("stream[1] must be Address"),
    }

    let expected_i128_scval: xdr::ScVal = (-5_i128).into();
    match (&values[2], expected_i128_scval) {
        (xdr::ScVal::I128(v), xdr::ScVal::I128(expected)) => assert_eq!(v, &expected),
        _ => panic!("stream[2] must be i128"),
    }

    let decoded = Stream::try_from_val(&env, &stream_scval).unwrap();
    assert_eq!(decoded, stream);
}

#[test]
fn datakey_stream_serializes_deterministically_and_works_in_storage() {
    let env = Env::default();
    let contract_id = env.register(StreamContract, ());
    let key = DataKey::Stream(42_u64);

    let key_scval_a: xdr::ScVal = (&key).try_into().unwrap();
    let key_scval_b: xdr::ScVal = (&key).try_into().unwrap();
    assert_eq!(key_scval_a, key_scval_b);

    let expected_key_scval: xdr::ScVal =
        (&(Symbol::new(&env, "Stream"), 42_u64)).try_into().unwrap();
    assert_eq!(key_scval_a, expected_key_scval);

    let decoded_key = DataKey::try_from_val(&env, &key_scval_a).unwrap();
    assert_eq!(decoded_key, key);

    let recipient = Address::generate(&env);
    let stream = Stream(42_u64, recipient, 99_i128);

    env.as_contract(&contract_id, || {
        env.storage().persistent().set(&key, &stream);
        let stored: Stream = env.storage().persistent().get(&key).unwrap();
        assert_eq!(stored, stream);
    });
}
