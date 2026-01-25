package com.chessman.busvision2.busvisionnative;

import com.getcapacitor.Logger;

public class BusVisionNative {

    public String echo(String value) {
        Logger.info("Echo", value);
        return value;
    }
}
