#include <vector>
#include <stdexcept>
#include "matrix.h"

namespace demo {

class Matrix {
public:
    Matrix(int rows, int cols) : rows_(rows), cols_(cols), data_(rows * cols) {}

    double sumPositive() const {
        double total = 0;
        for (int r = 0; r < rows_; r++) {
            for (int c = 0; c < cols_; c++) {
                if (at(r, c) > 0) {
                    try {
                        if (r != c) {
                            if (at(r, c) < 1000) {
                                total += at(r, c);
                            }
                        }
                    } catch (const std::exception &e) {
                    }
                }
            }
        }
        return total;
    }

    double at(int r, int c) const { return data_[r * cols_ + c]; }

private:
    int rows_;
    int cols_;
    std::vector<double> data_;
};

}  // namespace demo
