use serde::{Deserialize, Serialize};

#[derive(Deserialize, Debug, Clone)]
pub struct Point3d {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Serialize, Debug)]
pub struct PostureData {
    // These need to be public so the frontend can access them
    pub ves_ratio: f32,
    pub tilt_angle: f32,
    pub pitch_angle: f32,
    pub is_centered: bool,
}

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

    // Calculate the midpoint of the shoulders
    let shoulder_mid_x = (left_shoulder.x + right_shoulder.x) / 2.0;
    let shoulder_mid_y = (left_shoulder.y + right_shoulder.y) / 2.0;
    let shoulder_width = (left_shoulder.x - right_shoulder.x).abs().max(0.001);

    let ves_ratio = (shoulder_mid_y - nose.y).abs() / shoulder_width;
    
    // Figure out the tilt angle
    let tilt_angle = (nose.x - shoulder_mid_x).atan2(shoulder_mid_y - nose.y).to_degrees();
    let pitch_angle = 0.0; // Not sure about this one yet

    PostureData {
        ves_ratio,
        tilt_angle,
        pitch_angle,
        is_centered: ves_ratio < 0.8, 
    }
}

// This function starts the app
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![analyze_posture])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
