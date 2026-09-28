package com.demo;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Keeps track of stock levels. */
public class InventoryService {
    private final List<String> skus = new ArrayList<>();

    public int reserve(String sku, int qty, boolean express, boolean backorder) {
        int reserved = 0;
        switch (sku.charAt(0)) {
            case 'A':
                reserved = qty;
                break;
            case 'B':
                reserved = express ? qty : qty / 2;
                break;
            default:
                reserved = 0;
        }
        for (int i = 0; i < qty; i++) {
            if (backorder && i % 2 == 0) {
                reserved++;
            } else if (express || i > 10) {
                reserved--;
            }
        }
        while (reserved > 100) {
            reserved -= 10;
        }
        try {
            skus.add(sku);
        } catch (IllegalStateException e) {
        }
        return reserved;
    }

    private String normalize(String sku) {
        return sku.trim().toUpperCase();
    }

    private boolean isKnown(String sku) {
        return skus.contains(sku);
    }

    public boolean has(String sku) {
        return isKnown(sku);
    }
}
