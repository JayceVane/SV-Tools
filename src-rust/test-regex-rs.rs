use regex::Regex;

fn main() {
    let text = " module my_module #( parameter WIDTH = 8 )( input wire clk ); endmodule ";

    // Test the pattern
    let pattern = r"(?s)(?<!\S)module(?!\S).+?(?<!\S)endmodule(?!\S)";
    let re = Regex::new(pattern).unwrap();

    if let Some(m) = re.find(text) {
        println!("Match found: {}", m.as_str());
    } else {
        println!("No match!");
    }

    // Test just the lookbehind
    let pattern2 = r"(?<!\S)module(?!\S)";
    let re2 = Regex::new(pattern2).unwrap();
    if let Some(m) = re2.find(text) {
        println!("Module pattern match: {}", m.as_str());
    } else {
        println!("Module pattern no match!");
    }

    // Test simpler pattern
    let pattern3 = r"(?s)module(?!\S).+?endmodule(?!\S)";
    let re3 = Regex::new(pattern3).unwrap();
    if let Some(m) = re3.find(text) {
        println!("Simple pattern match: {}", m.as_str());
    } else {
        println!("Simple pattern no match!");
    }
}
