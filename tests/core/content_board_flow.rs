//! Board items as stored content: sealed by human devices, taken by the hub, received in the hub's order and
//! in another, merged into boards that agree; what the envelope layer refuses never reaches a board.

use trommi_core::board_items::{Applied, Board, ItemBody, Unread};
use trommi_core::chain::{hub_take, receive, seal_next, Mode, Outcome, OwnChain, Role, Served};
use trommi_core::crypto::SigningKey;
use trommi_core::envelope::{Draft, Subject, Timeline};
use trommi_core::ids::{BoardId, DeviceId, GroupId};
use trommi_core::registers::{self, OwnIds};
use trommi_core::Error;
use trommi_tests::content::{shape, Dice, View, ROOM};
use trommi_tests::vectors::entropy;

const NOW: u64 = 1_800_000_000_000;
const KEY: [u8; 32] = [7; 32];

struct Human {
    signer: SigningKey,
    id: DeviceId,
    view: View,
    own: OwnChain,
    board: Board,
}

/// Receives one stored envelope at `human` and hands a board item's body on to its board.
fn take(human: &mut Human, board: &BoardId, bytes: &[u8]) -> Result<Option<Applied>, Error> {
    let receipt = receive(
        &human.view,
        &human.view,
        &human.view.chains,
        &human.view.objects,
        &human.id,
        bytes,
        &Served::Stored,
        Mode::InOrder,
        NOW,
    )?;
    human.view.store(&receipt)?;
    let header = &receipt.envelope().header;
    let on_board =
        matches!(&header.subject, Subject::Item(Timeline::Board(named)) if named == board);
    let Outcome::Taken { body, .. } = receipt.outcome() else {
        return Ok(None);
    };
    if !on_board {
        return Ok(None);
    }
    match body
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|body| ItemBody::decode(body.payload()))
    {
        Ok(item) => human.board.apply(header.sender, header.seq, item).map(Some),
        Err(Error::NewerVersion) => {
            human
                .board
                .skip_unread(header.sender, header.seq, Unread::Newer);
            Ok(None)
        }
        Err(_) => Ok(None),
    }
}

#[test]
fn two_devices_draw_on_one_board_and_agree() {
    let mut dice = Dice(entropy("content board flow").unwrap());
    let group = GroupId::room(ROOM);
    let board = BoardId::new(dice.bytes().unwrap());
    let signers = [1u8, 2].map(|_| SigningKey::generate(&mut dice.0).unwrap());
    let leaves: Vec<(DeviceId, Role)> = signers
        .iter()
        .map(|signer| (DeviceId::new(signer.public()), Role::Human))
        .collect();
    let mut hub = View::new(group, &leaves, None);
    let mut humans: Vec<Human> = signers
        .into_iter()
        .map(|signer| Human {
            id: DeviceId::new(signer.public()),
            signer,
            view: View::new(group, &leaves, Some(KEY)),
            own: OwnChain::new(),
            board: Board::new(),
        })
        .collect();

    // Each device writes board items, and between them a register, so that its numbers have holes for the
    // board. The hub takes every envelope without reading it.
    let mut log: Vec<Vec<u8>> = Vec::new();
    let mut ids = [OwnIds::new(), OwnIds::new()];
    for round in 0..24u32 {
        let who = (dice.below(2).unwrap()) as usize;
        let human = &mut humans[who];
        let draft = if round % 5 == 4 {
            let value = registers::Value {
                name: "crown".to_owned(),
                value: Some("{}".to_owned()),
                lamport: u64::from(round) + 1,
            };
            let id = ids[who].id_for("crown", &mut dice.0).unwrap();
            Draft::register(id, &value.payload().unwrap())
        } else {
            let body = match dice.below(4).unwrap() {
                0 | 1 => {
                    ItemBody::Strokes(vec![shape(&mut dice).unwrap(), shape(&mut dice).unwrap()])
                }
                2 => ItemBody::Move {
                    shapes: human.board.shapes().map(|(id, _)| *id).take(2).collect(),
                    offset: [16, -32],
                },
                _ => ItemBody::Erase(human.board.shapes().map(|(id, _)| *id).take(1).collect()),
            };
            let Ok(payload) = body.encode() else {
                // Nothing on the board yet to move or erase.
                continue;
            };
            Draft::board_item(board, payload.expose()).with_files(body.file_ids())
        };
        let sealed = seal_next(
            &human.view,
            &human.view.chains,
            &human.view.objects,
            &mut human.own,
            &draft,
            group,
            &human.signer,
            NOW,
            &mut dice.0,
        )
        .unwrap();
        let bytes = sealed.envelope.encode().unwrap();
        let receipt = hub_take(
            &hub,
            &hub,
            &hub.chains,
            &hub.objects,
            &human.id,
            &bytes,
            NOW,
        )
        .unwrap();
        assert!(matches!(
            receipt.outcome(),
            Outcome::Taken {
                body: Err(Error::NoKey),
                ..
            }
        ));
        hub.store(&receipt).unwrap();
        // The writer sees its own item at once; the other device only at the end.
        take(human, &board, &bytes).unwrap();
        log.push(bytes);
    }

    // Each device now receives what the other wrote, in the hub's order. Its own envelopes are a replay.
    for human in &mut humans {
        for bytes in &log {
            match take(human, &board, bytes) {
                Ok(_) | Err(Error::Replay) => {}
                Err(other) => panic!("{other:?}"),
            }
        }
    }
    assert!(humans[0].board.shapes().count() > 0);
    assert_eq!(humans[0].board, humans[1].board);

    // A device that reads the whole log in the hub's order from nothing gets the same board.
    let late = SigningKey::generate(&mut dice.0).unwrap();
    let mut late = Human {
        id: DeviceId::new(late.public()),
        signer: late,
        view: View::new(group, &leaves, Some(KEY)),
        own: OwnChain::new(),
        board: Board::new(),
    };
    for bytes in &log {
        take(&mut late, &board, bytes).unwrap();
    }
    assert_eq!(late.board, humans[0].board);
}

#[test]
fn an_agent_writes_no_board_item() {
    let mut dice = Dice(entropy("content board flow agent").unwrap());
    let group = GroupId::room(ROOM);
    let agent = SigningKey::generate(&mut dice.0).unwrap();
    let agent_id = DeviceId::new(agent.public());
    // Even a hub that listed an agent device as a leaf of the room group could not make its item count.
    let view = View::new(group, &[(agent_id, Role::Agent)], Some(KEY));
    let body = ItemBody::Strokes(vec![shape(&mut dice).unwrap()]);
    let draft = Draft::board_item(BoardId::ALL_DESKS, body.encode().unwrap().expose());
    let refused = seal_next(
        &view,
        &view.chains,
        &view.objects,
        &mut OwnChain::new(),
        &draft,
        group,
        &agent,
        NOW,
        &mut dice.0,
    );
    assert_eq!(refused.err(), Some(Error::Forbidden));
}
