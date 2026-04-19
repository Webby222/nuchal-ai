use serde::{Deserialize, Serialize};

#[derive(Deserialize, Debug, Clone)]
pub struct Point3d {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Serialize, Debug)]
pub struct PostureData {
    pub ves_ratio: f32,        // signed — direction preserved
    pub tilt_angle: f32,       // signed — forward = positive
    pub pitch_angle: f32,      // signed — face up = positive
    pub horizontal_offset: f32,// nose drift from shoulder center
    pub is_centered: bool,
}

#[tauri::command]
fn analyze_posture(landmarks: Vec<Point3d>) -> PostureData {
    if landmarks.len() < 13 {
        return PostureData {
            ves_ratio: 0.0,
            tilt_angle: 0.0,
            pitch_angle: 0.0,
            horizontal_offset: 0.0,
            is_centered: false,
        };
    }

    let nose = &landmarks[0];
    let left_shoulder = &landmarks[11];
    let right_shoulder = &landmarks[12];

    let shoulder_mid_x = (left_shoulder.x + right_shoulder.x) / 2.0;
    let shoulder_mid_y = (left_shoulder.y + right_shoulder.y) / 2.0;
    let shoulder_width = (left_shoulder.x - right_shoulder.x).abs().max(0.001);

    // SIGNED — no .abs() — direction matters
    let ves_ratio = (shoulder_mid_y - nose.y) / shoulder_width;

    // Horizontal drift of nose from shoulder center
    let horizontal_offset = (nose.x - shoulder_mid_x) / shoulder_width;

    // Signed tilt — forward head = positive
    let neck_vec_x = shoulder_mid_x - nose.x;
    let neck_vec_y = shoulder_mid_y - nose.y;
    let tilt_angle = neck_vec_x.atan2(neck_vec_y).to_degrees();

    // Pitch from chin(152) and forehead(10) if available
    let pitch_angle = if landmarks.len() > 152 {
        let chin = &landmarks[152];
        let forehead = &landmarks[10];
        let pitch_vec_x = forehead.x - chin.x;
        let pitch_vec_y = forehead.y - chin.y;
        (-pitch_vec_y).atan2(pitch_vec_x).to_degrees() - 90.0
    } else {
        0.0
    };

    // is_centered uses horizontal offset now — more meaningful
    let is_centered = horizontal_offset.abs() < 0.15;

    PostureData {
        ves_ratio,
        tilt_angle,
        pitch_angle,
        horizontal_offset,
        is_centered,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![analyze_posture])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}