use serde::{Deserialize, Serialize};

#[derive(Deserialize, Debug, Clone)]
pub struct Point3d {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Serialize, Debug)]
pub struct PostureData {
    // Fields MUST be pub so the frontend can read them
    pub ves_ratio: f32,
    pub tilt_angle: f32,
    pub pitch_angle: f32,
    pub is_centered: bool,
}

// Command MUST NOT be pub in lib.rs to avoid E0255
#[tauri::command]
fn analyze_posture(landmarks: Vec<Point3d>) -> PostureData {
    if landmarks.is_empty() {
        return PostureData {
            ves_ratio: 0.0,
            tilt_angle: 0.0,
            pitch_angle: 0.0,
            is_centered: false,
        };
    }

    let nose = &landmarks[0];
    let left_shoulder = &landmarks[11];
    let right_shoulder = &landmarks[12];

    // Basic calculation logic
    let shoulder_mid_x = (left_shoulder.x + right_shoulder.x) / 2.0;
    let shoulder_mid_y = (left_shoulder.y + right_shoulder.y) / 2.0;
    let shoulder_width = (left_shoulder.x - right_shoulder.x).abs().max(0.001);

    let ves_ratio = (shoulder_mid_y - nose.y).abs() / shoulder_width;
    
    // Placeholder angles - you can refine these formulas as needed
    let tilt_angle = (nose.x - shoulder_mid_x).atan2(shoulder_mid_y - nose.y).to_degrees();
    let pitch_angle = 0.0; // Placeholder

    PostureData {
        ves_ratio,
        tilt_angle,
        pitch_angle,
        is_centered: ves_ratio < 0.8, 
    }
}

// Entry point MUST be pub so main.rs can call it
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![analyze_posture])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
