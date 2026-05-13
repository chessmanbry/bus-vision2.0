import { BusVisionNative } from 'bus-vision-native';

window.testEcho = () => {
    const inputValue = document.getElementById("echoInput").value;
    BusVisionNative.echo({ value: inputValue })
}
