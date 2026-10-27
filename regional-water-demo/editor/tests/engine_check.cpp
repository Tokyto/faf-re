// Compile against the actual v0.5 engine headers, not a reimplementation.
#include "moho/sim/RegionalWaterMapModel.h"
#include <iostream>
#include <string>
int main() {
  int width, depth, enabled; float sea; std::size_t length;
  while (std::cin >> width >> depth >> sea >> enabled >> length) {
    std::cin.get(); std::string text(length, '\0');
    std::cin.read(text.data(), static_cast<std::streamsize>(length));
    const auto d = moho::regionalwater::ParseMapDefinition(text);
    std::cout << (d && !moho::regionalwater::ValidateMapDefinition(d,width,depth,sea,enabled!=0) ? "OK\n" : "ERR\n");
  }
}
