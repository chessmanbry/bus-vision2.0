package com.chessman.busvision2.native;

import com.getcapacitor.Logger;

public class BusVisionNative {

    public String echo(String value) {
        Logger.info("Echo", value);
        return value;
    }
}
